'use strict';

// The bare-rpc boundary between the Electron main process and the Bare worker
// hosting peer.cjs. All of this also works in-process (pairing.cjs, exec.cjs);
// what this file proves is that it survives the RPC channel, including the
// worker-to-main push commands carrying streamed exec output.

const test = require('brittle');
const os = require('node:os');

const { createWorkerPeers, runExec, waitFor, waitForExecChannel } = require('../helpers/index.cjs');

// The worker path adds an RPC round-trip and a process spawn on top of the DHT
// handshake, so a tighter bound than this failed intermittently.
const PAIR_TIMEOUT_MS = 30_000;

async function pairWorkers(t, label) {
  const { clients: [host, guest] } = await createWorkerPeers(t, 2, { label });

  const hostPaired = waitFor(host, 'peer:paired', null, PAIR_TIMEOUT_MS);
  const guestPaired = waitFor(guest, 'peer:paired', null, PAIR_TIMEOUT_MS);

  const invite = await host.createInvite({ autoApprove: true });
  const accepted = await guest.acceptInvite(invite.invite, {
    userData: { name: 'guest-from-rpc-test', hostname: os.hostname() },
    code: invite.pairingCode,
  });

  const [hostEvent, guestEvent] = await Promise.all([hostPaired, guestPaired]);
  return { host, guest, hostEvent, guestEvent, accepted };
}

test('worker-client - peers pair across the RPC boundary', async (t) => {
  const { hostEvent, guestEvent, accepted } = await pairWorkers(t, 'rpc-pair');

  t.is(hostEvent.discoveryKey, guestEvent.discoveryKey, 'discovery keys survive serialisation');
  t.is(accepted.discoveryKey, hostEvent.discoveryKey, 'the RPC return value agrees');
});

// listPeers is a request/response command, unlike the event push above.
test('worker-client - listPeers round-trips on both sides', async (t) => {
  const { host, guest } = await pairWorkers(t, 'rpc-list');

  t.is((await host.listPeers()).length, 1);
  t.is((await guest.listPeers()).length, 1);
});

// Exec output arrives via the worker→main push commands (EXEC_CHUNK/EXEC_EXIT),
// which is the part most likely to break independently of the in-process path.
test('worker-client - exec output streams back through the push commands', async (t) => {
  const { guest, guestEvent } = await pairWorkers(t, 'rpc-exec');
  await waitForExecChannel(guest, guestEvent.discoveryKey, 10_000);

  const result = await runExec(
    guest,
    {
      peerId: guestEvent.discoveryKey,
      code: 'console.log("hello-from-rpc-exec")',
      mode: 'inline',
    },
    20_000,
  );

  t.ok(result.stdout.includes('hello-from-rpc-exec'), 'stdout crossed the RPC boundary');
});

test('worker-client - dropPeer over RPC removes the pair', async (t) => {
  const { host, hostEvent } = await pairWorkers(t, 'rpc-drop');

  await host.dropPeer(hostEvent.discoveryKey);

  t.is((await host.listPeers()).length, 0);
});
