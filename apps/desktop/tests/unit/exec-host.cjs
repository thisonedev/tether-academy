'use strict';

// The host side of peer-exec, driven through a fake transport. Covers the run
// slot and cancel paths with no child to signal; escalation needs a real spawn: tests/integration/exec-cancel.cjs.

const test = require('brittle');
const { spawn } = require('node:child_process');

const {
  createExecHost,
  isAlive,
  PEER_ERROR_TEXT,
  WIRE_SAFE_META,
  RUN_FINAL_IDLE_MS,
} = require('../../workers/peer/exec-host.cjs');

const PEER = 'a'.repeat(64);

// exec:request rate-limiting is module-level state; fakeHost() resets it
// each call so a growing test file never trips it for unrelated tests.
const { _resetAllForTests: resetRateLimit } = require('../../workers/peer/rate-limit.cjs');

// Keeps tests off @qvac/sdk and a loaded model; override via ctx for a real verdict.
const CLEAN_SCAN = async () => ({ modelName: null, result: { verdict: 'clean', concerns: [] } });

// Records everything the host tried to send back so assertions can read it.
function fakeHost(ctx = {}) {
  resetRateLimit();
  const replies = [];
  const audit = [];
  const events = [];
  const host = createExecHost({
    sendReply: (discoveryKey, payload) => replies.push({ discoveryKey, ...payload }),
    appendAudit: (type, payload) => audit.push({ type, ...payload }),
    emit: (event, payload) => events.push({ event, payload }),
    getPeerUserData: () => ({ name: 'test-peer' }),
    getExecPath: () => process.execPath,
    getBareRuntimeBinPath: () => null,
    awaitDeviceVerified: async () => ({ ok: true, reason: null }),
    runSecurityScan: CLEAN_SCAN,
    ...ctx,
  });
  return { host, replies, audit, events };
}

const MIC_CODE = 'const ffmpeg = startMicrophone({ sampleRate: 16000 });';
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Pins the distinction that made cancel report success while the workload kept running.
test('exec-host - liveness is the child exit state, not child.killed', async (t) => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 50);"]);
  t.teardown(() => child.kill('SIGKILL'));
  await new Promise((resolve) => setTimeout(resolve, 200));

  t.ok(isAlive(child), 'a running child is alive');
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));

  t.is(child.killed, true, 'node marks the child killed once a signal is sent');
  t.ok(isAlive(child), 'but the child that ignored SIGTERM is still alive');

  child.kill('SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 300));
  t.absent(isAlive(child), 'SIGKILL actually ends it');
});

test('exec-host - a run parked on device consent still holds the peer slot', async (t) => {
  const { host, replies } = fakeHost();
  t.teardown(() => host.stopAll());

  host.handleRequest(PEER, { kind: 'request', code: MIC_CODE, mode: 'inline' });
  await settle();
  t.is(host.listDeviceRequests().length, 1, 'the run is waiting on a human');
  t.ok(host.hasRun(PEER), 'and occupies the slot while it waits');

  // Without the slot a peer could fire N requests during the consent window and get N concurrent runs on approval.
  host.handleRequest(PEER, { kind: 'request', code: 'console.log(1)', mode: 'inline' });
  await settle();
  const refusal = replies.find((r) => r.kind === 'error');
  t.ok(refusal, 'the second request is refused');
  t.ok(/already running/.test(refusal.message), 'and says why');
  t.is(host.listDeviceRequests().length, 1, 'no second prompt was raised');
});

test('exec-host - a malicious security verdict refuses the run before any consent prompt', async (t) => {
  const { host, replies, audit } = fakeHost({
    runSecurityScan: async () => ({
      modelName: 'test-model',
      result: { verdict: 'malicious', concerns: [{ summary: 'reads ~/.ssh/id_rsa', snippet: 'readFileSync' }] },
    }),
  });
  t.teardown(() => host.stopAll());

  host.handleRequest(PEER, { kind: 'request', code: 'console.log(1)', mode: 'inline' });
  await settle();

  t.is(host.listDeviceRequests().length, 0, 'no human is ever asked');
  t.absent(host.hasRun(PEER), 'the slot is released');
  const err = replies.find((r) => r.kind === 'error');
  t.ok(err, 'the run is refused');
  t.is(err.code, 'security-flagged', 'with the security-flagged code');
  const flagged = audit.find((a) => a.type === 'peer:exec:security-flagged');
  t.ok(flagged, 'the concerns are kept in the local audit trail');
  t.ok(/reads ~\/.ssh\/id_rsa/.test(flagged.concerns[0]), 'including what was flagged');
});

// Only 'malicious' has teeth now; 'suspicious' proved unreliable and no
// longer forces a prompt on its own.
test('exec-host - a suspicious security verdict does not force a prompt on its own', async (t) => {
  const { host } = fakeHost({
    runSecurityScan: async () => ({
      modelName: 'test-model',
      result: {
        verdict: 'suspicious',
        concerns: [{ summary: 'unrelated network call to an unfamiliar host', snippet: 'fetch(...)' }],
      },
    }),
  });
  t.teardown(() => host.stopAll());

  host.handleRequest(PEER, { kind: 'request', code: 'console.log(1)', mode: 'inline' });
  await settle();

  t.is(host.listDeviceRequests().length, 0, 'a run needing no device/network access still runs unprompted');
  t.ok(host.hasRun(PEER), 'and is not refused either');
});

// 'suspicious' is still worth showing when a prompt is already happening for
// a real device/network reason, just not on its own.
test('exec-host - a suspicious verdict still rides along on a prompt already needed for device access', async (t) => {
  const { host } = fakeHost({
    runSecurityScan: async () => ({
      modelName: 'test-model',
      result: {
        verdict: 'suspicious',
        concerns: [{ summary: 'unrelated network call to an unfamiliar host', snippet: 'fetch(...)' }],
      },
    }),
  });
  t.teardown(() => host.stopAll());

  host.handleRequest(PEER, { kind: 'request', code: MIC_CODE, mode: 'inline' });
  await settle();

  const [pending] = host.listDeviceRequests();
  t.ok(pending, 'the mic ask still raises a prompt');
  t.alike(pending.concerns, ['unrelated network call to an unfamiliar host'], 'carrying the concern summary');
});

// Pins a past bug: a scan that couldn't even run once forced a prompt on
// every remote run with no chat model loaded, benign code included.
test('exec-host - a security scan that cannot run does not force a prompt on its own', async (t) => {
  const { host } = fakeHost({
    runSecurityScan: async () => {
      throw new Error('no model loaded');
    },
  });
  t.teardown(() => host.stopAll());

  host.handleRequest(PEER, { kind: 'request', code: 'console.log(1)', mode: 'inline' });
  await settle();

  t.is(host.listDeviceRequests().length, 0, 'a run needing no device/network access still runs unprompted');
  t.ok(host.hasRun(PEER), 'and is not refused either');
});

// `code` is buildLesson()'s wrapped output; scan and preview should see the
// underlying lesson source instead, though `code` is still what spawns.
test('exec-host - the security scan and the human-facing preview use the raw source, not the wrapped code', async (t) => {
  let scannedCode = null;
  const { host } = fakeHost({
    runSecurityScan: async ({ code }) => {
      scannedCode = code;
      return { modelName: 'test-model', result: { verdict: 'clean', concerns: [] } };
    },
  });
  t.teardown(() => host.stopAll());

  // A mic ask still needs a real consent prompt regardless of the security
  // verdict; that's what gives this test a prompt to inspect the preview on.
  host.handleRequest(PEER, {
    kind: 'request',
    code: `import { x } from "/abs/node_modules/x";\n${MIC_CODE}`,
    mode: 'inline',
    declared: { rawSource: 'console.log(1)' },
  });
  await settle();

  t.is(scannedCode, 'console.log(1)', 'the security scan sees the lesson source, not the build harness');
  const [pending] = host.listDeviceRequests();
  t.is(pending.sourcePreview, 'console.log(1)', 'the consent prompt preview does too');
});

test('exec-host - cancel unparks a run waiting on device consent', async (t) => {
  const { host, replies, audit } = fakeHost();
  t.teardown(() => host.stopAll());

  host.handleRequest(PEER, { kind: 'request', code: MIC_CODE, mode: 'inline' });
  await settle();
  t.is(host.listDeviceRequests().length, 1, 'parked on the prompt');

  t.ok(host.cancel(PEER), 'cancel is accepted while parked');
  await settle();

  t.is(host.listDeviceRequests().length, 0, 'the prompt is withdrawn');
  t.absent(host.hasRun(PEER), 'the slot is released');
  const err = replies.find((r) => r.kind === 'error');
  t.ok(/cancelled/i.test(err.message), 'the peer is told it was cancelled, not denied');
  const resolved = audit.find((a) => a.type === 'peer:exec:device-resolved');
  t.is(resolved.approved, false, 'the device grant is recorded as refused');
  t.is(resolved.reason, 'cancelled', 'with the cancel as the reason');
});

test('exec-host - denied device access refuses the run rather than running it muted', async (t) => {
  const { host, replies } = fakeHost();
  t.teardown(() => host.stopAll());

  host.handleRequest(PEER, { kind: 'request', code: MIC_CODE, mode: 'inline' });
  await settle();
  const [pending] = host.listDeviceRequests();
  host.resolveDeviceRequest(pending.requestId, false);
  await settle();

  const err = replies.find((r) => r.kind === 'error');
  t.ok(/microphone/.test(err.message), 'the refusal names the device');
  t.absent(host.hasRun(PEER), 'and the slot is released');
  t.absent(replies.some((r) => r.kind === 'started'), 'nothing was ever spawned');
});

// Revocation drops the pairing; this is the second gate, the one the run itself has to pass.
test('exec-host - a revoked device gets no run', async (t) => {
  const revoked = 'b'.repeat(64);
  const { host, replies } = fakeHost({ getRevokedDeviceKey: () => revoked });
  t.teardown(() => host.stopAll());

  host.handleRequest(PEER, { kind: 'request', code: 'console.log(1)', mode: 'inline' });
  await settle();

  const err = replies.find((r) => r.kind === 'error');
  t.ok(/revoked/i.test(err.message), 'the refusal says the device was revoked');
  t.is(err.devicePublicKey, revoked, 'and names the key');
  t.absent(host.hasRun(PEER), 'no slot was taken');
  t.absent(replies.some((r) => r.kind === 'started'), 'nothing was spawned');
});

test('exec-host - an unproven device gets no run', async (t) => {
  const { host, replies } = fakeHost({
    awaitDeviceVerified: async () => ({ ok: false, reason: 'timeout' }),
  });
  t.teardown(() => host.stopAll());

  host.handleRequest(PEER, { kind: 'request', code: 'console.log(1)', mode: 'inline' });
  await settle();

  const err = replies.find((r) => r.kind === 'error');
  t.ok(/has not proven/i.test(err.message), 'the refusal says the key is unproven');
  t.is(err.reason, 'timeout', 'and carries why the handshake did not settle');
  t.absent(host.hasRun(PEER), 'the slot is released');
  t.absent(replies.some((r) => r.kind === 'started'), 'nothing was spawned');
});

// The key available before the handshake is self-reported, so the revocation
// list is read again once the wait is over.
test('exec-host - revocation is re-checked against the proven key', async (t) => {
  const revoked = 'b'.repeat(64);
  let proven = false;
  const { host, replies } = fakeHost({
    getRevokedDeviceKey: () => (proven ? revoked : null),
    awaitDeviceVerified: async () => {
      proven = true;
      return { ok: true, reason: null };
    },
  });
  t.teardown(() => host.stopAll());

  host.handleRequest(PEER, { kind: 'request', code: 'console.log(1)', mode: 'inline' });
  await settle();

  const err = replies.find((r) => r.kind === 'error');
  t.ok(/revoked/i.test(err.message), 'the run is refused once the key is known');
  t.absent(host.hasRun(PEER), 'the slot is released');
  t.absent(replies.some((r) => r.kind === 'started'), 'nothing was spawned');
});

// A ctx with no transport cannot prove anything about the peer.
test('exec-host - the handshake gate has no fail-open default', async (t) => {
  const replies = [];
  const host = createExecHost({
    sendReply: (discoveryKey, payload) => replies.push({ discoveryKey, ...payload }),
    appendAudit: () => {},
    emit: () => {},
    getPeerUserData: () => null,
    getExecPath: () => process.execPath,
    getBareRuntimeBinPath: () => null,
  });
  t.teardown(() => host.stopAll());

  host.handleRequest(PEER, { kind: 'request', code: 'console.log(1)', mode: 'inline' });
  await settle();

  t.is(replies.find((r) => r.kind === 'error')?.reason, 'no-handshake');
  t.absent(replies.some((r) => r.kind === 'started'));
});

// A failing run must not leak the host's username, home layout, or tool paths; the peer gets fixed text plus a code to branch on.
test('exec-host - a host error does not travel to the peer', async (t) => {
  const { host, replies, audit } = fakeHost();
  t.teardown(() => host.stopAll());

  // Rejected by sanitizeExecCode, whose message is written host-side.
  host.handleRequest(PEER, { kind: 'request', code: 42, mode: 'inline' });
  await settle();

  const err = replies.find((r) => r.kind === 'error');
  t.is(err.code, 'invalid-request', 'the peer gets a code to branch on');
  t.is(err.message, PEER_ERROR_TEXT['invalid-request'], 'and the fixed text for it');

  const recorded = audit.find((a) => a.type === 'peer:exec:error');
  t.is(recorded.code, 'invalid-request');
  t.not(recorded.message, err.message, 'the local trail keeps what the host actually saw');
});

// Sandbox warnings name the paths they failed on, and changed model names are host filenames, so meta can leak as much as the message.
test('exec-host - path-bearing meta is not on the wire allowlist', (t) => {
  for (const field of ['warnings', 'changedModels', 'label', 'cwd']) {
    t.absent(WIRE_SAFE_META.includes(field), `${field} stays local`);
  }
  t.ok(WIRE_SAFE_META.includes('mode'), 'the peer still gets back what it sent');
  t.ok(WIRE_SAFE_META.includes('fileName'));
});

test('exec-host - every code has text a peer can be shown', (t) => {
  for (const [code, entry] of Object.entries(PEER_ERROR_TEXT)) {
    const text = typeof entry === 'function' ? entry({}) : entry;
    t.ok(typeof text === 'string' && text.length > 0, `${code} has text`);
    t.absent(/undefined|\[object/.test(text), `${code} renders with empty meta`);
  }
});

// A run parked on the handshake has no child, so cancel has to settle the wait itself; leaving it to time out held the peer slot and made Stop look dead.
test('exec-host - cancel unparks a run waiting on the identity handshake', async (t) => {
  const { host, replies } = fakeHost({
    // Never settles on its own, standing in for a handshake that stalls.
    awaitDeviceVerified: () => new Promise(() => {}),
  });
  t.teardown(() => host.stopAll());

  host.handleRequest(PEER, { kind: 'request', code: 'console.log(1)', mode: 'inline' });
  await settle();
  t.ok(host.hasRun(PEER), 'the run holds the slot while it waits');

  t.ok(host.cancel(PEER), 'cancel is accepted while parked');
  await settle();

  t.absent(host.hasRun(PEER), 'the slot is released without waiting out the timeout');
  const err = replies.find((r) => r.kind === 'error');
  t.is(err.code, 'cancelled', 'reported as cancelled, not as an unproven device');
  t.absent(replies.some((r) => r.kind === 'started'), 'nothing was spawned');
});

test('exec-host - cancel on an idle peer is a no-op', (t) => {
  const { host } = fakeHost();
  t.absent(host.cancel(PEER), 'nothing to cancel');
});

// A throw from inside spawnRun (after the run slot is taken) used to leave the peer silent, the run dir on disk, and nothing in the audit.
test('exec-host - a throw inside spawnRun is reported with a stable code', async (t) => {
  // Earlier tests in this file already consumed the per-key exec:request budget, which would hit the limiter before reaching spawnRun.
  const { _resetAllForTests } = require('../../workers/peer/rate-limit.cjs');
  _resetAllForTests();

  const { host, replies, audit } = fakeHost({
    // Throws after the run slot has been taken, so the catch handles it.
    getExecPath: () => {
      throw new Error('interpreter exploded');
    },
  });
  t.teardown(() => host.stopAll());

  // A node-only import makes detectNodeOnly pick the node runtime, the only path that calls getExecPath() and lets
  // the throw land in spawnRun's promise; the leading slash mirrors the build step's absolute-path output.
  host.handleRequest(PEER, {
    kind: 'request',
    code: 'import foo from "/abs/node_modules/some-pkg/index.js"; console.log(foo);',
    mode: 'inline',
  });
  await settle();
  // Wait a few ticks for the spawnRun rejection handler to run.
  await settle();
  await settle();
  await settle();

  const err = replies.find((r) => r.kind === 'error');
  t.ok(err, 'the peer is told something happened');
  t.is(err.code, 'spawn-failed', 'with the stable code, not the host-side error text');
  t.is(err.message, PEER_ERROR_TEXT['spawn-failed'], 'and the fixed text for that code');
  t.ok(
    audit.some((a) => a.type === 'peer:exec:error' && a.code === 'spawn-failed'),
    'an audit event is recorded',
  );
  t.absent(host.hasRun(PEER), 'and the slot is released');
});

// Pins the constant behind the BCI-idle fix, so a tuning edit isn't silent; the actual behaviour is covered by tests/integration/exec-cancel.cjs.
test('exec-host - RUN_FINAL_IDLE_MS is large enough not to trip a quiet compute phase', (t) => {
  t.ok(RUN_FINAL_IDLE_MS >= 10_000, 'idle threshold >= 10s');
});
