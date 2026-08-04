'use strict';

// Regression: the guest read the approval response from the DHT, so a failed
// or stale put left it on acceptInvite's 30-minute timeout. The host now also
// pushes the response down the exec channel; these sabotage delivery via _testHooks.

const test = require('brittle');
const os = require('node:os');

const { createPeers, waitFor } = require('../helpers/index.cjs');

const PENDING_TIMEOUT_MS = 30_000;
// The failure mode is a 30-minute hang, so anything in seconds proves delivery; kept tight since a working push lands in milliseconds.
const PAIR_TIMEOUT_MS = 5000;
const BUDGET_MS = 2000;

async function pairWithSabotage(t, label, sabotage) {
  const { peers: [host, guest] } = await createPeers(t, 2, { label });

  const pendingPromise = waitFor(host, 'peer:pending', null, PENDING_TIMEOUT_MS);
  const invite = await host.createInvite();
  const accepted = guest
    .acceptInvite(invite.invite, {
      userData: { name: `guest-${label}`, hostname: os.hostname() },
      code: invite.pairingCode,
    })
    .catch(() => {});
  const pending = await pendingPromise;

  // Applied only now, so the host's setup completes normally and the sabotage isolates what happens inside approve().
  sabotage(host);
  t.teardown(() => {
    host._testHooks.setSkipDhtPut(false);
    host._testHooks.setSkipBlindPairingChannel(false);
  });

  const guestPaired = waitFor(guest, 'peer:paired', null, PAIR_TIMEOUT_MS);
  const hostPaired = waitFor(host, 'peer:paired', null, PAIR_TIMEOUT_MS);

  const start = Date.now();
  t.is(await host.approve(pending.requestId), true, 'approve succeeded');

  const guestEvent = await guestPaired;
  const elapsed = Date.now() - start;
  const hostEvent = await hostPaired;
  await accepted;

  t.is(hostEvent.discoveryKey, guestEvent.discoveryKey);
  t.is(hostEvent.autobaseKey, guestEvent.autobaseKey);
  t.is(hostEvent.role, 'host');
  t.is(guestEvent.role, 'guest');

  return elapsed;
}

test('direct-push - guest pairs with the DHT put skipped', async (t) => {
  const elapsed = await pairWithSabotage(t, 'dht-skip', (host) => {
    host._testHooks.setSkipDhtPut(true);
  });

  t.comment(`guest paired in ${elapsed}ms with no DHT put`);
  t.ok(elapsed < PAIR_TIMEOUT_MS, 'the DHT is not on the critical path');
});

// With both cut, only the exec channel can carry the response.
test('direct-push - guest pairs with both the DHT and the blind-pairing channel skipped', async (t) => {
  const elapsed = await pairWithSabotage(t, 'both-skip', (host) => {
    host._testHooks.setSkipDhtPut(true);
    host._testHooks.setSkipBlindPairingChannel(true);
  });

  t.comment(`guest paired in ${elapsed}ms via the exec channel alone`);
  t.ok(
    elapsed < BUDGET_MS,
    `expected under ${BUDGET_MS}ms; slower means the exec-channel push is not delivering`,
  );
});
