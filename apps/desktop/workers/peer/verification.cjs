// Who is on the other end of a pair, after the handshake, and which device
// keys the identity owner has revoked.
//
// `createVerification` owns the in-flight handshake sessions, the verification
// waiters, and the claim-matching rule. `createRevocation` owns the revoked-
// devices set and the bookkeeping that has to fire when it changes. Both are
// plain factories; they take their collaborators explicitly so `index.cjs`
// stays the one place that wires transport, exec, and pairing.
//
// The dependency runs one way: this file never imports `index.cjs`.
'use strict';

function createVerification({
  identityHandshake,
  // A getter, because the keypair is derived after this factory runs and is
  // dropped again by close(). Capturing the value once meant signing every
  // proof reply with whatever was there at wiring time.
  getSigningKeyPair,
  peers,
  identitySessions,
  sendIdentityFrame,
  isRevokedDevice,
  emit,
  appendAudit,
  dropPeer,
}) {
  const verificationWaiters = new Map();

  function handleIdentityFrame(discoveryKeyHex, msg) {
    const session = identitySessions.get(discoveryKeyHex);
    if (!session) return;

    if (msg.kind === identityHandshake.HELLO_KIND) {
      // The first hello carries the device and identity keys the sender will
      // prove possession of. A second hello is rejected wholesale: the proof
      // is bound to the nonce, so allowing more than one would let a peer
      // rebind an already-verified session to a key it has not proven.
      if (session.remote) return;
      const remote = identityHandshake.readHello(msg);
      if (!remote) return;
      const signingKeyPair = getSigningKeyPair();
      if (!signingKeyPair) return;
      session.remote = remote;
      sendIdentityFrame(
        discoveryKeyHex,
        identityHandshake.buildProofReply(discoveryKeyHex, remote.nonce, signingKeyPair),
      );
    } else if (msg.kind === identityHandshake.PROOF_KIND) {
      if (!session.remote) return;
      // Store the key the signature actually covered, not a boolean. A later
      // hello cannot reach this field, and applyIdentityResult reads from
      // here rather than from session.remote.
      session.verifiedDevicePublicKey = identityHandshake.verifyProofReply(msg, {
        discoveryKeyHex,
        nonce: session.nonce,
        devicePublicKey: session.remote.devicePublicKey,
      })
        ? session.remote.devicePublicKey
        : null;
      // Same pinning for the identity half: only set if the same proof also
      // attests the identity key. Both come from the same hello, so a
      // different key on the wire cannot move this value either.
      session.verifiedIdentityPublicKey =
        session.remote.identityProven && session.verifiedDevicePublicKey
          ? session.remote.identityPublicKey
          : null;
    }
    applyIdentityResult(discoveryKeyHex);
  }

  /**
   * Fold a completed handshake into the peer record. Both halves have to be in
   * before anything is stored: the announced keys, and the signature showing the
   * sender holds the device key it announced.
   */
  function applyIdentityResult(discoveryKeyHex) {
    const session = identitySessions.get(discoveryKeyHex);
    const peer = peers.get(discoveryKeyHex);
    if (!session || !peer || session.applied) return;
    if (!session.remote || !session.verifiedDevicePublicKey) return;
    session.applied = true;

    // Read the proven keys, not the announced ones. A second hello can no
    const devicePublicKey = session.verifiedDevicePublicKey;
    const identityPublicKey = session.verifiedIdentityPublicKey;
    const identityVerified = !!identityPublicKey;
    peer.verifiedDevicePublicKey = devicePublicKey;
    peer.verifiedIdentityPublicKey = identityVerified ? identityPublicKey : null;
    peer.identityVerified = identityVerified;

    appendAudit('peer:identity-verified', {
      discoveryKey: discoveryKeyHex,
      devicePublicKey,
      identityPublicKey: peer.verifiedIdentityPublicKey,
      identityVerified,
    });
    emit('peer:identity-verified', {
      discoveryKey: discoveryKeyHex,
      ...peerIdentityView(peer),
    });

    if (isRevokedDevice(devicePublicKey)) {
      appendAudit('peer:rejected', {
        discoveryKey: discoveryKeyHex,
        reason: 'device-revoked',
        devicePublicKey,
      });
      dropPeer(discoveryKeyHex).catch(() => {});
      return;
    }

    // The guest took the host's identity from the invite link, which anyone can
    // rewrite. Now that the host has proven one, the two have to agree.
    if (
      peer.role === 'guest' &&
      peer.hostIdentity &&
      !claimMatches(peer.hostIdentity, session.remote)
    ) {
      appendAudit('peer:rejected', {
        discoveryKey: discoveryKeyHex,
        reason: 'host-identity-mismatch',
        claimed: peer.hostIdentity,
        devicePublicKey,
      });
      dropPeer(discoveryKeyHex).catch(() => {});
      return;
    }

    // Last: a result that ends in a drop wakes its waiters from dropPeer
    // instead, once the peer entry is already gone.
    settleVerificationWaiters(discoveryKeyHex);
  }

  // Invite links have carried either key depending on whether the host had a
  // root identity when it made the invite, so either is a match.
  function claimMatches(claimed, remote) {
    if (claimed === remote.devicePublicKey) return true;
    return remote.identityProven && claimed === remote.identityPublicKey;
  }

  /**
   * Whether the handshake has proven who is on the wire for this peer, and
   * whether what it proved is what the peer claimed when it paired. A
   * `pending` reason is not a failure: the proof reply may still be in flight.
   * @returns {{ ok: boolean, reason: string | null }}
   */
  function peerVerification(discoveryKeyHex) {
    const peer = peers.get(discoveryKeyHex);
    if (!peer) return { ok: false, reason: 'no-peer' };
    if (!peer.verifiedDevicePublicKey) return { ok: false, reason: 'pending' };

    // userData is what the peer said about itself at pairing time, and a
    // revoked device can put anything there. Once a key is proven the two
    // have to agree, so a device cannot clear the pre-approval checks under
    // a borrowed key.
    const claimedDevice = peer.userData?.devicePublicKey ?? null;
    if (typeof claimedDevice === 'string' && claimedDevice !== peer.verifiedDevicePublicKey) {
      return { ok: false, reason: 'device-key-mismatch' };
    }
    const claimedIdentity = peer.userData?.identityPublicKey ?? null;
    if (typeof claimedIdentity === 'string') {
      if (!peer.identityVerified) return { ok: false, reason: 'identity-unproven' };
      if (claimedIdentity !== peer.verifiedIdentityPublicKey) {
        return { ok: false, reason: 'identity-mismatch' };
      }
    }
    return { ok: true, reason: null };
  }

  /** Wake everything parked on this peer's handshake. */
  function settleVerificationWaiters(discoveryKeyHex) {
    const waiters = verificationWaiters.get(discoveryKeyHex);
    if (!waiters) return;
    verificationWaiters.delete(discoveryKeyHex);
    const state = peerVerification(discoveryKeyHex);
    for (const settle of waiters) settle(state);
  }

  /** Wake every park so close() / lockdown can drain everything in flight. */
  function settleAllWaiters() {
    for (const discoveryKeyHex of Array.from(verificationWaiters.keys())) {
      settleVerificationWaiters(discoveryKeyHex);
    }
  }

  /**
   * Resolve once this peer's handshake has settled either way. A timeout
   * counts as unverified, so a peer that never answers never runs.
   */
  function awaitPeerVerification(discoveryKeyHex, timeoutMs) {
    const current = peerVerification(discoveryKeyHex);
    if (current.reason !== 'pending') return Promise.resolve(current);

    return new Promise((resolve) => {
      const settle = (state) => {
        clearTimeout(timer);
        resolve(state);
      };
      const timer = setTimeout(() => {
        verificationWaiters.get(discoveryKeyHex)?.delete(settle);
        resolve({ ok: false, reason: 'timeout' });
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      const waiters = verificationWaiters.get(discoveryKeyHex) ?? new Set();
      waiters.add(settle);
      verificationWaiters.set(discoveryKeyHex, waiters);
    });
  }

  function peerIdentityView(peer) {
    return {
      identityVerified: !!peer.identityVerified,
      verifiedDevicePublicKey: peer.verifiedDevicePublicKey ?? null,
      verifiedIdentityPublicKey: peer.verifiedIdentityPublicKey ?? null,
    };
  }

  return {
    handleIdentityFrame,
    applyIdentityResult,
    claimMatches,
    peerVerification,
    settleVerificationWaiters,
    settleAllWaiters,
    awaitPeerVerification,
  };
}

function createRevocation({ peers, pendingRequests, appendAudit, dropPeer, reject }) {
  let revokedDevices = new Set();

  /**
   * Replace the revoked-device set and act on it. Revoking a device the user
   * is already paired with has to end that pairing, and withdraw any request
   * from it still sitting on the approval screen. Otherwise revocation only
   * applies to devices that were not going to be a problem anyway.
   */
  function setRevokedDevices(keys) {
    revokedDevices = new Set(Array.isArray(keys) ? keys : []);
    let dropped = 0;
    for (const [discoveryKeyHex, peer] of Array.from(peers.entries())) {
      if (!peer.verifiedDevicePublicKey) continue;
      if (!revokedDevices.has(peer.verifiedDevicePublicKey)) continue;
      appendAudit('peer:rejected', {
        discoveryKey: discoveryKeyHex,
        reason: 'device-revoked',
        devicePublicKey: peer.verifiedDevicePublicKey,
      });
      dropPeer(discoveryKeyHex).catch(() => {});
      dropped += 1;
    }

    let withdrawn = 0;
    for (const [requestId, pending] of Array.from(pendingRequests.entries())) {
      const claimed = pending.userData?.devicePublicKey ?? null;
      if (typeof claimed !== 'string' || !revokedDevices.has(claimed)) continue;
      reject(requestId).catch(() => {});
      withdrawn += 1;
    }

    return { revoked: revokedDevices.size, dropped, withdrawn };
  }

  function isRevokedDevice(devicePublicKey) {
    return typeof devicePublicKey === 'string' && revokedDevices.has(devicePublicKey);
  }

  // Used by the exec-host closure to decide, on every run, whether a paired
  // device has since been revoked. Reads `peers` fresh each call so the
  // closure never pins a stale key.
  function getRevokedDeviceKey(discoveryKeyHex) {
    const device = peers.get(discoveryKeyHex)?.verifiedDevicePublicKey ?? null;
    return device && revokedDevices.has(device) ? device : null;
  }

  return {
    setRevokedDevices,
    isRevokedDevice,
    getRevokedDeviceKey,
  };
}

module.exports = {
  createVerification,
  createRevocation,
};
