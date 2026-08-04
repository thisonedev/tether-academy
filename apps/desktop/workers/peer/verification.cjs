// Handshake verification and device revocation as plain factories; collaborators
// are passed in explicitly and this file never imports index.cjs.
'use strict';

function createVerification({
  identityHandshake,
  // Getter, not a value: capturing the keypair once would sign with stale material.
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
      // A second hello is rejected wholesale, since the proof is bound to the
      // nonce and would rebind a verified session to an unproven key.
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
      session.verifiedDevicePublicKey = identityHandshake.verifyProofReply(msg, {
        discoveryKeyHex,
        nonce: session.nonce,
        devicePublicKey: session.remote.devicePublicKey,
      })
        ? session.remote.devicePublicKey
        : null;
      session.verifiedIdentityPublicKey =
        session.remote.identityProven && session.verifiedDevicePublicKey
          ? session.remote.identityPublicKey
          : null;
    }
    applyIdentityResult(discoveryKeyHex);
  }

  // Requires both the announced keys and a signature proving the device key.
  function applyIdentityResult(discoveryKeyHex) {
    const session = identitySessions.get(discoveryKeyHex);
    const peer = peers.get(discoveryKeyHex);
    if (!session || !peer || session.applied) return;
    if (!session.remote || !session.verifiedDevicePublicKey) return;
    session.applied = true;

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

    // Invite links carry a host identity anyone can rewrite; the two must now agree.
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

    // A result that ends in a drop wakes its waiters from dropPeer instead.
    settleVerificationWaiters(discoveryKeyHex);
  }

  // Either key matches: invites have carried either depending on host identity.
  function claimMatches(claimed, remote) {
    if (claimed === remote.devicePublicKey) return true;
    return remote.identityProven && claimed === remote.identityPublicKey;
  }

  /**
   * `pending` is not a failure because the reply may still be in flight.
   * @returns {{ ok: boolean, reason: string | null }}
   */
  function peerVerification(discoveryKeyHex) {
    const peer = peers.get(discoveryKeyHex);
    if (!peer) return { ok: false, reason: 'no-peer' };
    if (!peer.verifiedDevicePublicKey) return { ok: false, reason: 'pending' };

    // userData is self-reported; once proven, it must agree with the key.
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

  /** Resolve once this peer's handshake has settled either way; a timeout counts as unverified. */
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

  // Ends any pairing already using a revoked device and withdraws its pending requests.
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

  // Reads `peers` fresh each call so the exec-host closure never pins a stale key.
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
