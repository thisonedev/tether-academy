const Hyperswarm = require('hyperswarm');
const BlindPairing = require('blind-pairing');
const crypto = require('node:crypto');
const os = require('node:os');

const AUDIT_CAP = 1000;

const toHex = (buf) => {
  if (buf == null) return null;
  if (typeof buf === 'string') return buf;
  return Buffer.from(buf).toString('hex');
};

const fromHex = (hex) => Buffer.from(hex, 'hex');

let swarm = null;
let pairing = null;
let identity = null;

const members = new Map();
const candidates = new Map();
const peers = new Map();
const pendingRequests = new Map();
const auditLog = [];
const listeners = new Set();

function emit(event, payload) {
  for (const listener of listeners) {
    try {
      listener(event, payload);
    } catch (err) {
      console.warn('[peer] listener error:', err?.message ?? err);
    }
  }
}

function appendAudit(type, payload) {
  const entry = { type, timestamp: Date.now(), ...payload };
  auditLog.push(entry);
  if (auditLog.length > AUDIT_CAP) auditLog.shift();
  emit('peer:audit', entry);
}

function safeParseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return { raw: str };
  }
}

async function init({ store, bootstrap = null }) {
  if (pairing) return pairing;
  if (!store?.identity) {
    throw new Error('peer.init: state-store identity is required');
  }
  identity = store.identity;

  const seed = fromHex(identity.publicKey);
  swarm = bootstrap ? new Hyperswarm({ seed, bootstrap }) : new Hyperswarm({ seed });

  await swarm.dht.fullyBootstrapped();
  pairing = new BlindPairing(swarm, { poll: 30_000 });

  console.log(
    `[peer] ready, identity pubkey ${identity.publicKey.slice(0, 16)}..., ` +
      `swarm pubkey ${toHex(swarm.keyPair.publicKey).slice(0, 16)}...`,
  );

  return pairing;
}

function ensureReady() {
  if (!pairing) throw new Error('peer not initialized; call peer.init first');
}

function getIdentity() {
  if (!identity) return null;
  return {
    publicKey: identity.publicKey,
    createdAt: identity.createdAt ?? null,
  };
}

function finalizePair(discoveryKeyHex, sessionPublicKey, role, userData, autobaseKey, inviteId) {
  const peerInfo = {
    discoveryKey: discoveryKeyHex,
    sessionPublicKey,
    role,
    pairedAt: Date.now(),
    userData,
    autobaseKey: toHex(autobaseKey),
    inviteId: inviteId ?? null,
  };
  peers.set(discoveryKeyHex, peerInfo);
  appendAudit('peer:paired', {
    discoveryKey: discoveryKeyHex,
    role,
    remoteUserData: userData,
  });
  emit('peer:paired', peerInfo);
  return peerInfo;
}

async function createInvite({ userData = null, autoApprove = false } = {}) {
  ensureReady();
  const autobaseKey = crypto.randomBytes(32);
  const { invite, publicKey, discoveryKey } = BlindPairing.createInvite(autobaseKey);
  const sessionPublicKey = toHex(publicKey);
  const discoveryKeyHex = toHex(discoveryKey);

  const member = pairing.addMember({
    discoveryKey,
    async onadd(candidate) {
      candidate.open(publicKey);
      const remoteUserData = candidate.userData
        ? safeParseJson(Buffer.from(candidate.userData).toString('utf8'))
        : null;
      const inviteIdHex = candidate.inviteId ? toHex(candidate.inviteId) : null;

      if (autoApprove) {
        candidate.confirm({ key: autobaseKey });
        finalizePair(discoveryKeyHex, sessionPublicKey, 'host', remoteUserData, autobaseKey, inviteIdHex);
        return;
      }

      const requestId = crypto.randomUUID();
      const pending = {
        requestId,
        discoveryKey: discoveryKeyHex,
        sessionPublicKey,
        candidate,
        autobaseKey,
        inviteId: inviteIdHex,
        userData: remoteUserData,
        receivedAt: Date.now(),
      };
      pendingRequests.set(requestId, pending);
      appendAudit('peer:pending', {
        requestId,
        discoveryKey: discoveryKeyHex,
        remoteUserData,
      });
      emit('peer:pending', {
        requestId,
        discoveryKey: discoveryKeyHex,
        sessionPublicKey,
        inviteId: inviteIdHex,
        userData: remoteUserData,
        receivedAt: pending.receivedAt,
      });
    },
  });
  await member.flushed();
  members.set(discoveryKeyHex, member);

  return {
    invite: Buffer.from(invite).toString('base64'),
    sessionPublicKey,
    discoveryKey: discoveryKeyHex,
    autobaseKey: toHex(autobaseKey),
    userData,
  };
}

async function approve(requestId) {
  const pending = pendingRequests.get(requestId);
  if (!pending) return false;
  pendingRequests.delete(requestId);
  pending.candidate.confirm({ key: pending.autobaseKey });
  finalizePair(
    pending.discoveryKey,
    pending.sessionPublicKey,
    'host',
    pending.userData,
    pending.autobaseKey,
    pending.inviteId,
  );
  appendAudit('peer:approved', { requestId, discoveryKey: pending.discoveryKey });
  return true;
}

async function reject(requestId) {
  const pending = pendingRequests.get(requestId);
  if (!pending) return false;
  pendingRequests.delete(requestId);
  pending.candidate._denied = true;
  const member = members.get(pending.discoveryKey);
  if (member) {
    await member.close().catch(() => {});
    members.delete(pending.discoveryKey);
  }
  appendAudit('peer:rejected', { requestId, discoveryKey: pending.discoveryKey });
  emit('peer:rejected', { requestId, discoveryKey: pending.discoveryKey });
  return true;
}

function listPending() {
  return Array.from(pendingRequests.values()).map(({ candidate, ...rest }) => rest);
}

function getAudit({ since = 0, limit = 200 } = {}) {
  const filtered = auditLog.filter((e) => e.timestamp >= since);
  return filtered.slice(-limit);
}

async function acceptInvite(inviteB64, { userData = null } = {}) {
  ensureReady();
  if (typeof inviteB64 !== 'string' || inviteB64.length === 0) {
    throw new Error('acceptInvite: invite must be a non-empty base64 string');
  }
  const invite = Buffer.from(inviteB64, 'base64');
  const { discoveryKey } = BlindPairing.decodeInvite(invite);
  const discoveryKeyHex = toHex(discoveryKey);

  const localUserData = userData ?? {
    name: os.hostname(),
    app: 'tether-academy',
  };

  const candidate = pairing.addCandidate({
    invite,
    userData: Buffer.from(JSON.stringify(localUserData), 'utf8'),
    async onadd(result) {
      const keyBuf = result?.key;
      finalizePair(
        discoveryKeyHex,
        null,
        'guest',
        localUserData,
        Buffer.isBuffer(keyBuf) ? keyBuf : null,
        null,
      );
    },
  });
  candidates.set(discoveryKeyHex, candidate);

  await candidate.pairing;

  return {
    discoveryKey: discoveryKeyHex,
    paired: !!candidate.paired,
  };
}

function listPeers() {
  return Array.from(peers.values());
}

async function dropPeer(discoveryKeyHex) {
  const peer = peers.get(discoveryKeyHex);
  if (!peer) return false;

  const member = members.get(discoveryKeyHex);
  if (member) {
    await member.close().catch(() => {});
    members.delete(discoveryKeyHex);
  }
  const candidate = candidates.get(discoveryKeyHex);
  if (candidate) {
    await candidate.close().catch(() => {});
    candidates.delete(discoveryKeyHex);
  }

  peers.delete(discoveryKeyHex);
  appendAudit('peer:dropped', { discoveryKey: discoveryKeyHex, role: peer.role });
  emit('peer:dropped', { discoveryKey: discoveryKeyHex });
  return true;
}

async function lockdown() {
  let dropped = 0;
  for (const requestId of Array.from(pendingRequests.keys())) {
    await reject(requestId);
    dropped++;
  }
  for (const discoveryKeyHex of Array.from(peers.keys())) {
    await dropPeer(discoveryKeyHex);
    dropped++;
  }
  appendAudit('peer:lockdown', { dropped });
  return dropped;
}

function on(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function close() {
  for (const m of members.values()) await m.close().catch(() => {});
  for (const c of candidates.values()) await c.close().catch(() => {});
  members.clear();
  candidates.clear();
  peers.clear();
  pendingRequests.clear();
  auditLog.length = 0;
  listeners.clear();
  if (pairing) await pairing.close().catch(() => {});
  if (swarm) await swarm.destroy().catch(() => {});
  pairing = null;
  swarm = null;
  identity = null;
}

module.exports = {
  init,
  getIdentity,
  createInvite,
  approve,
  reject,
  listPending,
  getAudit,
  acceptInvite,
  listPeers,
  dropPeer,
  lockdown,
  on,
  close,
};
