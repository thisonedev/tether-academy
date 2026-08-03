'use strict';

// The host side of peer-exec, driven through a fake transport. Covers the run
// slot and the cancel paths that have no child to signal yet. The escalation
// itself needs a real spawn: tests/integration/exec-cancel.cjs.

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

// Records everything the host tried to send back so assertions can read it.
function fakeHost(ctx = {}) {
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
    ...ctx,
  });
  return { host, replies, audit, events };
}

const MIC_CODE = 'const ffmpeg = startMicrophone({ sampleRate: 16000 });';
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Pins the distinction that made cancel report success while the workload
// kept running.
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

  // Without the slot a peer could fire N requests during the consent window and
  // get N concurrent runs the moment someone approves.
  host.handleRequest(PEER, { kind: 'request', code: 'console.log(1)', mode: 'inline' });
  await settle();
  const refusal = replies.find((r) => r.kind === 'error');
  t.ok(refusal, 'the second request is refused');
  t.ok(/already running/.test(refusal.message), 'and says why');
  t.is(host.listDeviceRequests().length, 1, 'no second prompt was raised');
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

// Revocation drops the pairing, so this is the second gate. It is the one the
// run itself has to pass.
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

// A paired peer that only ever fails a run should not learn the host's
// username, home layout, or which tools sit where. The host error stays in the
// local trail and the peer gets fixed text plus a code to branch on.
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

// The meta object leaked as much as the message did. Sandbox warnings name the
// paths they failed on, and changed model names are host filenames.
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

// A run parked on the handshake has no child, so cancel has to settle the wait
// itself. Leaving it to time out held the peer slot and made Stop look dead.
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

// A throw from inside spawnRun (after the run has been registered in the
// slot) used to leave the peer silent, the run dir on disk, and nothing
// in the audit. Drive that path and assert the catch runs the same
// cleanup every deliberate refusal runs.
test('exec-host - a throw inside spawnRun is reported with a stable code', async (t) => {
  // Earlier tests in this file already consumed the per-key exec:request
  // budget, so the test would hit the limiter before reaching spawnRun.
  const { _resetAllForTests } = require('../../workers/peer/rate-limit.cjs');
  _resetAllForTests();

  const { host, replies, audit } = fakeHost({
    // Throws after the run slot has been taken, so the catch handles it.
    getExecPath: () => {
      throw new Error('interpreter exploded');
    },
  });
  t.teardown(() => host.stopAll());

  // A node-only import (anything outside the bare-safe list) is what makes
  // detectNodeOnly pick the node runtime, which is the only path that calls
  // getExecPath() and lets the throw land in spawnRun's promise. The
  // PACKAGE_NAME regex requires an absolute path, so the specifier includes
  // a leading slash to mirror the build step's output.
  host.handleRequest(PEER, {
    kind: 'request',
    code: 'import foo from "/abs/node_modules/some-pkg/index.js"; console.log(foo);',
    mode: 'inline',
  });
  await settle();
  // The catch is on the spawnRun promise; wait a few ticks for the
  // rejection handler to run.
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

// Pin the constant that backs the BCI-idle fix. The actual final-idle
// behaviour needs a real spawn and so lives in tests/integration/exec-cancel.cjs
// (or a new integration test); pinning the value here stops a tuning edit
// from being a silent change.
test('exec-host - RUN_FINAL_IDLE_MS is large enough not to trip a quiet compute phase', (t) => {
  t.ok(RUN_FINAL_IDLE_MS >= 10_000, 'idle threshold >= 10s');
});
