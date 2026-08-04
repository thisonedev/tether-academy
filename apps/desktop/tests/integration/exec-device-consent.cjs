'use strict';

// A run wanting the microphone is held until a human answers, and the answer
// decides whether the sandbox grants it. Runs through the worker so consent crosses the real RPC boundary.

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

// Captures one second from the default mic and reports how much was not silence; a denied capture on macOS returns zeroes rather than an error.
const MIC_PROBE = `
  ${bareRequires('child_process')}
  const { spawnSync } = child_process;
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'avfoundation', '-i', ':default',
    '-t', '1', '-f', 'f32le', '-',
  ], { maxBuffer: 1 << 26 });
  const buf = r.stdout || Buffer.alloc(0);
  let nonZero = 0;
  for (const b of buf) if (b) nonZero++;
  console.log('PROBE:' + JSON.stringify({ status: r.status, bytes: buf.length, nonZero }));
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

test('device-consent - a mic run is held until the host answers', async (t) => {
  const { host, guest, peerId } = await pairedGuest(t, 'device-consent');

  const requested = waitFor(host, 'peer:exec:device-request', null, 20_000);
  const run = runExec(guest, { peerId, mode: 'inline', code: MIC_PROBE, label: 'mic test' }, 40_000);

  const request = await requested;
  t.alike(request.devices, ['microphone'], 'the host decided which device from the code');
  t.is(request.label, 'mic test');
  t.ok(request.requestId, 'the prompt is addressable');

  // Nothing has spawned yet: the run is parked on the answer.
  const listed = await host.listDeviceRequests();
  t.is(listed.length, 1, 'the pending prompt is readable over RPC');
  t.is(listed[0].requestId, request.requestId);

  t.is(await host.resolveDeviceRequest(request.requestId, true), true);
  const result = await run;

  t.ok(result.stdout.includes('"status":0'), `ffmpeg should run; got ${result.stdout.trim()}`);
  const probe = JSON.parse(result.stdout.match(/PROBE:(\{.*\})/)[1]);
  t.ok(probe.bytes > 0, 'audio was captured');
  t.ok(probe.nonZero > 0, 'approved capture is real audio, not the silence a denial returns');

  t.is(await host.resolveDeviceRequest(request.requestId, true), false, 'answered only once');
});

test('device-consent - a denied run is refused, never run muted', async (t) => {
  const { host, guest, peerId } = await pairedGuest(t, 'device-consent-deny');

  const requested = waitFor(host, 'peer:exec:device-request', null, 20_000);
  const run = runExec(guest, { peerId, mode: 'inline', code: MIC_PROBE }, 40_000).then(
    (ok) => ({ ok }),
    (err) => ({ err }),
  );

  const request = await requested;
  t.is(await host.resolveDeviceRequest(request.requestId, false), true);

  const outcome = await run;
  const message = outcome.err ? outcome.err.message : outcome.ok.stderr + outcome.ok.stdout;
  t.ok(/microphone/i.test(message), `refusal names the device; got: ${message}`);
  t.absent(/PROBE:/.test(message), 'a denied run does not execute at all');
});
