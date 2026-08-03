'use strict';

// Core pairing handshake over a real in-process DHT testnet: invite, accept,
// and what each side ends up knowing about the other.

const test = require('brittle');
const os = require('node:os');

const { createPeers, waitFor } = require('../helpers/index.cjs');

test('pairing - host and guest agree on the pair', async (t) => {
  const { peers: [host, guest] } = await createPeers(t, 2, { label: 'basic' });

  const hostPaired = waitFor(host, 'peer:paired');
  const guestPaired = waitFor(guest, 'peer:paired');

  const invite = await host.createInvite({ autoApprove: true });
  const accepted = await guest.acceptInvite(invite.invite, {
    userData: { name: 'guest-from-test', hostname: os.hostname() },
    code: invite.pairingCode,
    hostIdentity: host.getIdentity().publicKey,
  });

  const [hostEvent, guestEvent] = await Promise.all([hostPaired, guestPaired]);

  t.is(hostEvent.discoveryKey, guestEvent.discoveryKey, 'same discovery key');
  t.is(hostEvent.discoveryKey, accepted.discoveryKey, 'acceptInvite reports it too');
  t.is(hostEvent.autobaseKey, guestEvent.autobaseKey, 'same autobase key');
  t.is(hostEvent.role, 'host');
  t.is(guestEvent.role, 'guest');
});

test('pairing - userData and the pairing code reach the host', async (t) => {
  const { peers: [host, guest] } = await createPeers(t, 2, { label: 'userdata' });

  const hostPaired = waitFor(host, 'peer:paired');
  const invite = await host.createInvite({ autoApprove: true });
  await guest.acceptInvite(invite.invite, {
    userData: { name: 'guest-from-test' },
    code: invite.pairingCode,
  });

  const hostEvent = await hostPaired;
  t.is(hostEvent.userData?.name, 'guest-from-test');
  t.is(hostEvent.userData?.pairingCode, invite.pairingCode, 'guest echoes the code back');
});

// The guest learns who it paired with; the host has no symmetric field to fill
// in, so its own peerInfo must leave hostIdentity null rather than echo itself.
test('pairing - hostIdentity flows to the guest only', async (t) => {
  const { peers: [host, guest], identities: [hostDevice] } = await createPeers(t, 2, { label: 'identity' });

  const hostPaired = waitFor(host, 'peer:paired');
  const guestPaired = waitFor(guest, 'peer:paired');

  const invite = await host.createInvite({ autoApprove: true });
  await guest.acceptInvite(invite.invite, {
    userData: { name: 'guest-from-test' },
    code: invite.pairingCode,
    hostIdentity: hostDevice.publicKey,
  });

  const [hostEvent, guestEvent] = await Promise.all([hostPaired, guestPaired]);

  t.is(guestEvent.hostIdentity, hostDevice.publicKey);
  t.is(hostEvent.hostIdentity, null, 'host peerInfo carries no hostIdentity');
});

test('pairing - both sides list exactly one peer, and dropPeer removes it', async (t) => {
  const { peers: [host, guest] } = await createPeers(t, 2, { label: 'drop' });

  const hostPaired = waitFor(host, 'peer:paired');
  const guestPaired = waitFor(guest, 'peer:paired');
  const invite = await host.createInvite({ autoApprove: true });
  await guest.acceptInvite(invite.invite, {
    userData: { name: 'guest-from-test' },
    code: invite.pairingCode,
  });
  const [hostEvent] = await Promise.all([hostPaired, guestPaired]);

  t.is(host.listPeers().length, 1);
  t.is(guest.listPeers().length, 1);

  await host.dropPeer(hostEvent.discoveryKey);
  t.is(host.listPeers().length, 0, 'dropPeer removes the pair');
});
