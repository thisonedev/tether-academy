'use strict';

// The pairing bookkeeping is keyed off `discoveryKeyHex`, a value the remote
// side influences, and it is spread across `peers`, `candidates`,
// `execChannels`, `pendingByDiscovery` and `pendingByInvite`, each cleared from
// a different path: reject() and dropPeer() for the dedupe entries, mid-flight
// for candidates, channel close for execChannels. No test reached those tables
// before, which left an unapproved candidate touching a paired peer's state
// plausible.
//
// No exploit was found. These pin the transitions so a refactor of that
// bookkeeping has to keep them.

const test = require('brittle');

const { createPeers, waitFor } = require('../helpers/index.cjs');

// The absence of a second pending is not announced by any event.
const settle = (ms = 1000) => new Promise((resolve) => setTimeout(resolve, ms));

// reject() clears both dedupe entries and closes the member. If either survived,
// the discovery key would be stuck: the guest retries forever and the host
// drops each retry as a duplicate of a request it already threw away.
test('pairing-races - reject then approve on one discovery key', async (t) => {
  const { peers: [host, guest] } = await createPeers(t, 2, { label: 'race-reject' });

  const firstPending = waitFor(host, 'peer:pending', null, 15_000);
  const invite = await host.createInvite();
  guest
    .acceptInvite(invite.invite, {
      userData: { name: 'rejected-then-retried' },
      code: invite.pairingCode,
    })
    .catch(() => {});

  const pending = await firstPending;
  t.ok(await host.reject(pending.requestId), 'the first request is rejected');
  await settle();
  t.is(host.listPending().length, 0, 'and leaves nothing pending');
  t.is(host.listPeers().length, 0, 'and no peer');

  // A fresh invite is a fresh discovery key, so this also proves the rejected
  // one did not leave the guest wedged.
  const secondPending = waitFor(host, 'peer:pending', null, 15_000);
  const retry = await host.createInvite();
  guest
    .acceptInvite(retry.invite, {
      userData: { name: 'rejected-then-retried' },
      code: retry.pairingCode,
    })
    .catch(() => {});

  const second = await secondPending;
  t.ok(await host.approve(second.requestId), 'the retry can be approved');
  await settle();
  t.is(host.listPeers().length, 1, 'and pairs');
});

// approve() deliberately leaves the dedupe entries in place so the guest's
// continuous retries do not raise a second prompt. dropPeer() is the only thing
// that clears them, so a drop that missed one would make re-pairing impossible.
test('pairing-races - drop clears what approve deliberately left behind', async (t) => {
  const { peers: [host, guest] } = await createPeers(t, 2, { label: 'race-drop' });

  const paired = waitFor(host, 'peer:paired', null, 15_000);
  const invite = await host.createInvite({ autoApprove: true });
  await guest.acceptInvite(invite.invite, {
    userData: { name: 'dropped-then-repaired' },
    code: invite.pairingCode,
  });
  const event = await paired;

  t.ok(await host.dropPeer(event.discoveryKey), 'the pair is dropped');
  t.is(host.listPeers().length, 0);

  // Same guest, new invite. A stale pendingByDiscovery or pendingByInvite entry
  // would swallow this silently.
  const rePaired = waitFor(host, 'peer:paired', null, 15_000);
  const again = await host.createInvite({ autoApprove: true });
  await guest.acceptInvite(again.invite, {
    userData: { name: 'dropped-then-repaired' },
    code: again.pairingCode,
  });
  await rePaired;
  t.is(host.listPeers().length, 1, 're-pairing works after a drop');
});

// Two guests on one invite share a discovery key. Only one may become a peer,
// and the loser must not be able to reach the winner's exec channel: that is
// the state confusion the keying makes possible.
test('pairing-races - two candidates on one invite leave one peer', async (t) => {
  const { peers: [host, guestA, guestB] } = await createPeers(t, 3, { label: 'race-invite' });

  const firstPending = waitFor(host, 'peer:pending', null, 15_000);
  const invite = await host.createInvite();

  for (const [name, guest] of [['guest-a', guestA], ['guest-b', guestB]]) {
    guest
      .acceptInvite(invite.invite, { userData: { name }, code: invite.pairingCode })
      .catch(() => {});
  }

  const pending = await firstPending;
  await settle();
  t.is(host.listPending().length, 1, 'two candidates raise one prompt');

  t.ok(await host.approve(pending.requestId), 'the prompt is approved');
  await settle(1500);

  t.is(host.listPeers().length, 1, 'and exactly one peer results');
  const losers = [guestA, guestB].filter((g) => g.listPeers().length === 0);
  t.is(losers.length, 1, 'the other candidate is not paired');

  // The loser holds the discovery key, since it came from the invite it read.
  // Exec has to refuse it anyway, because it has no channel of its own.
  const [loser] = losers;
  t.exception(
    () => loser.exec({ peerId: host.listPeers()[0].discoveryKey, code: 'console.log(1)' }),
    /no exec channel/,
    'the unpaired candidate cannot reach the winner\'s channel',
  );
});
