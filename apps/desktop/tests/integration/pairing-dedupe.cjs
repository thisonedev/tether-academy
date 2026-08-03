'use strict';

// A host must surface exactly one pending request per invite, however many
// candidates arrive. blind-pairing can deliver onadd more than once, and each
// duplicate would otherwise be another approval prompt to dismiss.

const test = require('brittle');

const { createPeers, waitFor } = require('../helpers/index.cjs');

// Both cases assert the absence of extra pendings, which no event announces.
async function settle(ms = 1000) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test('dedupe - five parallel candidates produce one pending', async (t) => {
  const { peers } = await createPeers(t, 6, { label: 'dedupe-parallel' });
  const [host, ...guests] = peers;

  const firstPending = waitFor(host, 'peer:pending', null, 15_000);
  const invite = await host.createInvite();

  for (const [i, guest] of guests.entries()) {
    guest
      .acceptInvite(invite.invite, {
        userData: { name: `guest${i}`, source: 'dedupe-test' },
        code: invite.pairingCode,
      })
      .catch(() => {}); // losers reject by design; the host's count is what matters
  }

  await firstPending;
  await settle();

  t.is(host.listPending().length, 1, 'one pending under five racing candidates');
});

test('dedupe - the same guest accepting twice produces one pending', async (t) => {
  const { peers: [host, guest] } = await createPeers(t, 2, { label: 'dedupe-invite' });

  const firstPending = waitFor(host, 'peer:pending', null, 15_000);
  const invite = await host.createInvite();

  const accept = () =>
    guest
      .acceptInvite(invite.invite, {
        userData: { name: 'same-guest', source: 'invite-dedupe-test' },
        code: invite.pairingCode,
      })
      .catch(() => {});

  accept();
  await firstPending;
  await settle();
  t.is(host.listPending().length, 1, 'one pending after the first accept');

  // Same guest, same invite id, new pairing session.
  accept();
  await settle();
  t.is(host.listPending().length, 1, 'second accept did not add another pending');
});
