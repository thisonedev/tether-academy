'use strict';

// Manual approval: an invite created without autoApprove parks the guest in a
// pending state until the host approves. The guest has to learn about that
// approval, which is what the wake mechanism in pairing-wake.cjs makes fast.

const test = require('brittle');
const os = require('node:os');

const { createPeers, waitFor } = require('../helpers/index.cjs');

// DHT round-trip plus approve() can take a few seconds on a loaded machine.
const PAIR_TIMEOUT_MS = 30_000;

async function invite(host, guest) {
  const pending = waitFor(host, 'peer:pending', null, PAIR_TIMEOUT_MS);
  const created = await host.createInvite();
  const accepted = guest
    .acceptInvite(created.invite, {
      userData: { name: 'guest-needs-approval', hostname: os.hostname() },
      code: created.pairingCode,
    })
    .catch(() => {}); // resolves once approved; failures surface via the events
  return { created, accepted, pending: await pending };
}

test('approval - host sees a pending request instead of pairing immediately', async (t) => {
  const { peers: [host, guest] } = await createPeers(t, 2, { label: 'approval-pending' });

  const { pending } = await invite(host, guest);

  t.ok(pending.requestId, 'pending request has an id');
  t.is(host.listPeers().length, 0, 'nothing paired before approval');
});

test('approval - approving pairs both sides on the same keys', async (t) => {
  const { peers: [host, guest] } = await createPeers(t, 2, { label: 'approval-pair' });

  const { pending, accepted } = await invite(host, guest);

  // Registered after the pending arrives so the timeout covers only the approve.
  const hostPaired = waitFor(host, 'peer:paired', null, PAIR_TIMEOUT_MS);
  const guestPaired = waitFor(guest, 'peer:paired', null, PAIR_TIMEOUT_MS);

  t.is(await host.approve(pending.requestId), true, 'approve succeeded');

  const [hostEvent, guestEvent] = await Promise.all([hostPaired, guestPaired]);
  await accepted;

  t.is(hostEvent.discoveryKey, guestEvent.discoveryKey);
  t.is(hostEvent.autobaseKey, guestEvent.autobaseKey);
  t.is(hostEvent.role, 'host');
  t.is(guestEvent.role, 'guest');
});

test('approval - audit records pending, approved, and paired', async (t) => {
  const { peers: [host, guest] } = await createPeers(t, 2, { label: 'approval-audit' });

  const { pending, accepted } = await invite(host, guest);
  const hostPaired = waitFor(host, 'peer:paired', null, PAIR_TIMEOUT_MS);
  await host.approve(pending.requestId);
  await hostPaired;
  await accepted;

  const types = host.getAudit().map((e) => e.type);
  for (const expected of ['peer:pending', 'peer:approved', 'peer:paired']) {
    t.ok(types.includes(expected), `audit includes ${expected}`);
  }
});
