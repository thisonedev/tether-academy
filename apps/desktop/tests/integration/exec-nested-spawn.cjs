'use strict';

// A sandboxed lesson must be able to spawn an installed binary by name.
// Runs through the worker: one of the ways this broke only appears under Bare.

const test = require('brittle');
const os = require('node:os');

const {
  bareRequires,
  createWorkerPeers,
  runExec,
  waitFor,
  waitForExecChannel,
} = require('../helpers/index.cjs');
const { resolveExecName } = require('../../workers/sandbox/capabilities.cjs');

// Bounds a hang. Pairing has taken 15.8s on this machine under load.
const PAIR_TIMEOUT_MS = 45_000;

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
  return { guest, peerId: guestEvent.discoveryKey };
}

function spawnProbe(bin, args) {
  return `
    ${bareRequires('child_process')}
    const { spawnSync } = child_process;
    const r = spawnSync(${JSON.stringify(bin)}, ${JSON.stringify(args)}, { encoding: 'utf8' });
    console.log('PROBE:' + JSON.stringify({
      status: r.status,
      error: r.error && r.error.message,
    }));
  `;
}

// One pairing for both probes; the testnet and two Bare workers dominate cost.
test('nested-spawn - a sandboxed exec child can spawn allowlisted binaries by name', async (t) => {
  const { guest, peerId } = await pairedGuest(t, 'nested-spawn');

  const probe = async (bin, args) => {
    const result = await runExec(
      guest,
      { peerId, mode: 'inline', code: spawnProbe(bin, args) },
      20_000,
    );
    return result.stdout.trim();
  };

  // What MCP's StdioClientTransport does: a bare-named command via PATH.
  const npx = await probe('npx', ['--version']);
  t.ok(npx.includes('"status":0'), `nested npx spawn must succeed inside the sandbox; got: ${npx}`);

  // Where ffmpeg exists, Homebrew installs it as a symlink, which is the case that broke.
  if (!resolveExecName('ffmpeg')) {
    t.comment('ffmpeg not installed; skipping the symlinked-tool probe');
    return;
  }
  const ffmpeg = await probe('ffmpeg', ['-version']);
  t.ok(
    ffmpeg.includes('"status":0'),
    `ffmpeg is allowlisted in capabilities.cjs and must be runnable; got: ${ffmpeg}`,
  );
});
