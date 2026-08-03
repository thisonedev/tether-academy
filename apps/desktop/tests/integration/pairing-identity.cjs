'use strict';

// What a pair knows about who is on the other end, over a real in-process DHT
// testnet. The pairing code and the approval dialog gate who gets in; these
// cover the part that says which key got in.

const test = require('brittle');

const { attestedIdentity, createPeers, waitFor } = require('../helpers/index.cjs');

// Two peers, each with its own root identity and the proof for its device key.
async function createAttestedPeers(t, label) {
  const identities = [await attestedIdentity(), await attestedIdentity()];
  const { peers } = await createPeers(t, 2, {
    label,
    initFor: (i) => ({
      deviceIdentity: identities[i].deviceIdentity,
      attestation: identities[i].attestation,
    }),
  });
  return { host: peers[0], guest: peers[1], identities };
}

function auditMatching(peer, reason) {
  return waitFor(peer, 'peer:audit', (entry) => entry.reason === reason, 15_000);
}

test('pairing-identity - both sides prove which identity they are', async (t) => {
  const { host, guest, identities } = await createAttestedPeers(t, 'verified');
  const [hostId, guestId] = identities;

  const hostVerified = waitFor(host, 'peer:identity-verified', null, 15_000);
  const guestVerified = waitFor(guest, 'peer:identity-verified', null, 15_000);

  const invite = await host.createInvite({ autoApprove: true });
  await guest.acceptInvite(invite.invite, {
    userData: { name: 'attested-guest' },
    code: invite.pairingCode,
    hostIdentity: invite.hostIdentity,
  });

  const [hostSide, guestSide] = await Promise.all([hostVerified, guestVerified]);

  t.ok(hostSide.identityVerified, 'the host verified the guest');
  t.is(hostSide.verifiedIdentityPublicKey, guestId.attestation.identityPublicKey);
  t.is(hostSide.verifiedDevicePublicKey, guestId.attestation.devicePublicKey);

  t.ok(guestSide.identityVerified, 'and the guest verified the host');
  t.is(guestSide.verifiedIdentityPublicKey, hostId.attestation.identityPublicKey);

  const [hostPeer] = host.listPeers();
  t.ok(hostPeer.identityVerified, 'the peer record carries the result');
  t.is(hostPeer.verifiedIdentityPublicKey, guestId.attestation.identityPublicKey);
});

// The invite says whose identity the guest is about to pair with, and anyone
// who relays the link can rewrite that field.
test('pairing-identity - a host that is not the identity the link claimed is dropped', async (t) => {
  const { host, guest } = await createAttestedPeers(t, 'mismatch');
  const impostor = (await attestedIdentity()).attestation.identityPublicKey;

  const rejected = auditMatching(guest, 'host-identity-mismatch');
  const dropped = waitFor(guest, 'peer:dropped', null, 15_000);

  const invite = await host.createInvite({ autoApprove: true });
  await guest.acceptInvite(invite.invite, {
    userData: { name: 'misled-guest' },
    code: invite.pairingCode,
    hostIdentity: impostor,
  });

  const entry = await rejected;
  t.is(entry.claimed, impostor, 'the rejection records what the link claimed');
  await dropped;
  t.is(guest.listPeers().length, 0, 'the pair does not survive the mismatch');
});

test('pairing-identity - a peer with no identity to prove pairs as unverified', async (t) => {
  // A device key with no attestation chain behind it, which is what a device
  // that never finished identity setup looks like on the wire.
  const { peers: [host, guest] } = await createPeers(t, 2, {
    label: 'unattested',
    initFor: (i) => (i === 1 ? { attestation: null } : {}),
  });

  const hostVerified = waitFor(host, 'peer:identity-verified', null, 15_000);
  const invite = await host.createInvite({ autoApprove: true });
  await guest.acceptInvite(invite.invite, {
    userData: { name: 'legacy-guest' },
    code: invite.pairingCode,
  });

  const hostSide = await hostVerified;
  t.absent(hostSide.identityVerified, 'nothing vouches for the guest');
  t.ok(hostSide.verifiedDevicePublicKey, 'but it did prove it holds its device key');
  t.is(host.listPeers().length, 1, 'and the pair still works');
});

// Revocation has to cover the device trying to pair now and the one that is
// already paired.
test('pairing-identity - a revoked device is turned away at the invite', async (t) => {
  const identities = [await attestedIdentity(), await attestedIdentity()];
  const { peers: [host, guest] } = await createPeers(t, 2, {
    label: 'revoked-early',
    initFor: (i) => ({
      deviceIdentity: identities[i].deviceIdentity,
      attestation: identities[i].attestation,
      revokedDevices: i === 0 ? [identities[1].attestation.devicePublicKey] : [],
    }),
  });

  const rejected = auditMatching(host, 'device-revoked');
  const invite = await host.createInvite({ autoApprove: true });
  // Never resolves: the candidate is denied, so pairing has nothing to await.
  guest
    .acceptInvite(invite.invite, { userData: { name: 'revoked-guest' }, code: invite.pairingCode })
    .catch(() => {});

  const entry = await rejected;
  t.is(entry.devicePublicKey, identities[1].attestation.devicePublicKey);
  t.is(host.listPeers().length, 0, 'the host never paired with it');
});

test('pairing-identity - revoking a device withdraws its request from the approval screen', async (t) => {
  const { host, guest, identities } = await createAttestedPeers(t, 'revoked-pending');

  const pending = waitFor(host, 'peer:pending', null, 15_000);
  const invite = await host.createInvite();
  guest
    .acceptInvite(invite.invite, { userData: { name: 'waiting-guest' }, code: invite.pairingCode })
    .catch(() => {});
  await pending;
  t.is(host.listPending().length, 1, 'a human is being asked about it');

  const result = host.setRevokedDevices([identities[1].attestation.devicePublicKey]);
  t.is(result.withdrawn, 1, 'the request no longer waits on an answer');
  t.is(host.listPending().length, 0);
});

test('pairing-identity - revoking a paired device ends the pairing', async (t) => {
  const { host, guest, identities } = await createAttestedPeers(t, 'revoked-late');
  const guestDeviceKey = identities[1].attestation.devicePublicKey;

  const hostVerified = waitFor(host, 'peer:identity-verified', null, 15_000);
  const invite = await host.createInvite({ autoApprove: true });
  await guest.acceptInvite(invite.invite, {
    userData: { name: 'soon-revoked' },
    code: invite.pairingCode,
    hostIdentity: invite.hostIdentity,
  });
  await hostVerified;
  t.is(host.listPeers().length, 1, 'paired to start with');

  const dropped = waitFor(host, 'peer:dropped', null, 15_000);
  const result = host.setRevokedDevices([guestDeviceKey]);
  t.is(result.dropped, 1, 'an existing pairing is dropped too');

  await dropped;
  t.is(host.listPeers().length, 0);
});
