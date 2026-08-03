'use strict';

// Refusal paths: what happens when pairing should not succeed, and what the
// user is told about it. The happy approval path is pairing-approval.cjs.

const test = require('brittle');

const { createPeers, waitFor } = require('../helpers/index.cjs');

const WRONG_CODE = 'apple-baker-coral-drift';

async function inviteAndAccept(host, guest, { code, userData } = {}) {
  const invite = await host.createInvite();
  const accepted = guest
    .acceptInvite(invite.invite, {
      userData: userData ?? { name: 'test-guest' },
      code: code ?? invite.pairingCode,
    })
    .catch(() => {});
  return { invite, accepted };
}

test('security - rejecting a request leaves no pending and no peer', async (t) => {
  const { peers: [host, guest] } = await createPeers(t, 2, { label: 'sec-reject' });

  const pendingPromise = waitFor(host, 'peer:pending');
  await inviteAndAccept(host, guest, { userData: { name: 'guest-to-reject' } });
  const pending = await pendingPromise;

  t.is(await host.reject(pending.requestId), true, 'reject succeeded');
  t.is(host.listPending().length, 0, 'pending cleared');
  t.is(host.listPeers().length, 0, 'no peer added');
  t.ok(host.getAudit().map((e) => e.type).includes('peer:rejected'), 'audit records the rejection');
});

// A wrong code must not tell the attacker anything: no pending entry appears
// (so the user is not prompted), and the codes never reach the event stream,
// which the renderer can read.
test('security - a wrong pairing code is refused without leaking the code', async (t) => {
  const { peers: [host, guest] } = await createPeers(t, 2, { label: 'sec-mismatch' });

  const mismatch = waitFor(
    host,
    'peer:audit',
    (a) => a.type === 'peer:rejected' && a.reason === 'pairing-code-mismatch',
  );
  await inviteAndAccept(host, guest, { code: WRONG_CODE, userData: { name: 'wrong-code-guest' } });

  const audit = await mismatch;
  t.is(audit.expected, undefined, 'expected code absent from the event');
  t.is(audit.entered, undefined, 'entered code absent from the event');
  t.is(host.listPending().length, 0, 'no approval prompt for a wrong code');
  t.is(host.listPeers().length, 0, 'nothing paired');
});

// Attempts are counted so an invite can be invalidated after repeated guesses;
// the count itself is safe to expose, the codes are not.
test('security - a failed attempt is counted', async (t) => {
  const { peers: [host, guest] } = await createPeers(t, 2, { label: 'sec-attempts' });

  const mismatch = waitFor(
    host,
    'peer:audit',
    (a) => a.type === 'peer:rejected' && a.reason === 'pairing-code-mismatch',
  );
  await inviteAndAccept(host, guest, { code: 'AAAAAA', userData: { name: 'wrong-code-guest' } });

  t.is((await mismatch).attempts, 1, 'first failure recorded as attempt 1');
});

// buildId tells peers whether they are running compatible builds. It is a
// compatibility hint, not an authentication factor. Treating a mismatch as
// grounds for refusal would let anyone lock a peer out by claiming a version.
test('security - buildId is a compatibility hint, not a trust gate', async (t) => {
  const { peers: [host, guest] } = await createPeers(t, 2, { label: 'sec-buildid' });

  const pendingPromise = waitFor(host, 'peer:pending');
  await inviteAndAccept(host, guest, { userData: { name: 'compat-guest' } });
  const pending = await pendingPromise;

  t.is(pending.buildCompatible, true, 'same BUILD_ID reports compatible');
  t.absent(
    host.getAudit().some((e) => e.reason === 'unverified-build'),
    'buildId alone never triggers a rejection',
  );

  await host.reject(pending.requestId);
});

test('security - lockdown drops every paired peer', async (t) => {
  const { peers: [host, guest] } = await createPeers(t, 2, { label: 'sec-lockdown' });

  const paired = waitFor(guest, 'peer:paired');
  const invite = await host.createInvite({ autoApprove: true });
  await guest.acceptInvite(invite.invite, {
    userData: { name: 'guest-for-lockdown' },
    code: invite.pairingCode,
  });
  await paired;
  t.is(guest.listPeers().length, 1, 'paired before lockdown');

  t.is(await guest.lockdown(), 1, 'lockdown reports one peer dropped');
  t.is(guest.listPeers().length, 0, 'no peers remain');

  const entry = guest.getAudit().find((e) => e.type === 'peer:lockdown');
  t.is(entry?.dropped, 1, 'audit records how many were dropped');
});

// Lockdown is a panic button, so an un-approved request in flight has to go too
// Otherwise approving it afterwards would quietly re-open access.
test('security - lockdown also drops requests awaiting approval', async (t) => {
  const { peers: [host, guest] } = await createPeers(t, 2, { label: 'sec-lockdown-pending' });

  const pendingPromise = waitFor(host, 'peer:pending');
  await inviteAndAccept(host, guest, { userData: { name: 'never-approved' } });
  await pendingPromise;
  t.is(host.listPending().length, 1, 'one request awaiting approval');

  t.is(await host.lockdown(), 1, 'lockdown counts the pending request');
  t.is(host.listPending().length, 0, 'pending cleared');
});
