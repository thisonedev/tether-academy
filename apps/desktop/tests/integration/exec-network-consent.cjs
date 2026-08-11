'use strict';

// Egress is a per-run grant on the same prompt the microphone uses. Runs through
// the worker, so the decision is made where it really is: host-side.

const test = require('brittle');
const os = require('node:os');

const {
  bareRequires,
  createWorkerPeers,
  runExec,
  waitFor,
  waitForExecChannel,
} = require('../helpers/index.cjs');

const PAIR_TIMEOUT_MS = 45_000;

// A raw TCP connect, reporting a definite outcome either way; the address is assembled at runtime, so the source itself names no host.
const REACH_PROBE = `
  ${bareRequires('process', 'net')}
  const done = (o) => { console.log('PROBE:' + JSON.stringify(o)); process.exit(0); };
  // An IP, so nothing depends on DNS being reachable either way.
  const socket = net.connect(443, ['1.1', '.1.1'].join(''));
  socket.on('connect', () => done({ reached: true }));
  socket.on('error', (e) => done({ reached: false, code: e.code || String(e.message) }));
  setTimeout(() => done({ reached: false, code: 'TIMEOUT' }), 8000);
`;

// Same probe, but the source names a host, which is what the decision keys on.
const NAMED_HOST_PROBE = `
  // reaches https://one.one.one.one
  ${REACH_PROBE}
`;

async function pairedGuest(t, label) {
  const { clients: [host, guest] } = await createWorkerPeers(t, 2, {
    label,
  });

  const hostPaired = waitFor(host, 'peer:paired', null, PAIR_TIMEOUT_MS);
  const guestPaired = waitFor(guest, 'peer:paired', null, PAIR_TIMEOUT_MS);
  const invite = await host.createInvite({ autoApprove: true });
  await guest.acceptInvite(invite.invite, {
    userData: { name: `${label}-guest`, hostname: os.hostname() },
    code: invite.pairingCode,
  });
  const [, guestEvent] = await Promise.all([hostPaired, guestPaired]);

  await waitForExecChannel(guest, guestEvent.discoveryKey, 10_000);
  return { host, guest, peerId: guestEvent.discoveryKey };
}

const probeOf = (stdout) => {
  const match = stdout.match(/PROBE:(\{.*\})/);
  return match ? JSON.parse(match[1]) : null;
};

// run-tests.mjs only keeps lines matching /^\s*not ok/ in its CI summary;
// a raw newline in a failure message would drop everything after it.
const oneLine = (s) => s.replace(/\s*\n\s*/g, ' | ');

test('network-consent - a run that names no host is never asked and reaches nothing', async (t) => {
  const { host, guest, peerId } = await pairedGuest(t, 'network-none');

  const result = await runExec(guest, { peerId, mode: 'inline', code: REACH_PROBE }, 40_000);

  t.is((await host.listDeviceRequests()).length, 0, 'nothing was put to a human');
  const probe = probeOf(result.stdout);
  t.ok(
    probe,
    oneLine(`the child produced a PROBE line; stdout=${result.stdout} stderr=${result.stderr}`),
  );
  if (!probe) return;

  t.absent(probe.reached, `expected no egress; got ${JSON.stringify(probe)}`);
});

test('network-consent - a run that names a host is held until the host answers', async (t) => {
  // Pairing alone can take up to PAIR_TIMEOUT_MS; brittle's 30s default
  // test timeout can't hold both that and the consent round trip after it.
  t.timeout(PAIR_TIMEOUT_MS + 30_000);
  const { host, guest, peerId } = await pairedGuest(t, 'network-allow');

  const requested = waitFor(host, 'peer:exec:device-request', null, 20_000);
  const run = runExec(
    guest,
    { peerId, mode: 'inline', code: NAMED_HOST_PROBE, label: 'net test' },
    40_000,
  );

  const request = await requested;
  t.alike(request.devices, [], 'no hardware is being asked for');
  t.ok(request.network, 'the prompt says why the run wants the network');
  t.is(request.label, 'net test');

  t.is(await host.resolveDeviceRequest(request.requestId, true), true);
  const result = await run;
  const probe = probeOf(result.stdout);
  t.ok(
    probe,
    oneLine(`the child produced a PROBE line; stdout=${result.stdout} stderr=${result.stderr}`),
  );
  if (!probe) return;

  t.ok(probe.reached, `an approved run reaches the host; got ${JSON.stringify(probe)}`);
});

test('network-consent - a denied run is refused, never run offline', async (t) => {
  const { host, guest, peerId } = await pairedGuest(t, 'network-deny');

  const requested = waitFor(host, 'peer:exec:device-request', null, 20_000);
  const run = runExec(guest, { peerId, mode: 'inline', code: NAMED_HOST_PROBE }, 40_000).then(
    (ok) => ({ ok }),
    (err) => ({ err }),
  );

  const request = await requested;
  t.is(await host.resolveDeviceRequest(request.requestId, false), true);

  const outcome = await run;
  const message = outcome.err ? outcome.err.message : outcome.ok.stderr + outcome.ok.stdout;
  t.ok(/network/i.test(message), `refusal names what was denied; got: ${message}`);
  t.absent(/PROBE:/.test(message), 'a denied run does not execute at all');
});
