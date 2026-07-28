const Hyperswarm = require('hyperswarm');
const BlindPairing = require('blind-pairing');
const crypto = require('node:crypto');
const os = require('node:os');

const toHex = (buf) => {
  if (buf == null) return null;
  if (typeof buf === 'string') return buf;
  return Buffer.from(buf).toString('hex');
};

let swarm = null;
let pairing = null;
let identity = null;

const members = new Map();
const candidates = new Map();
const peers = new Map();
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

function fromHex(hex) {
  return Buffer.from(hex, 'hex');
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

async function createInvite({ userData = null } = {}) {
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
      candidate.confirm({ key: autobaseKey });

      const peerInfo = {
        discoveryKey: discoveryKeyHex,
        sessionPublicKey,
        role: 'host',
        pairedAt: Date.now(),
        userData: remoteUserData,
        autobaseKey: toHex(autobaseKey),
        inviteId: candidate.inviteId ? toHex(candidate.inviteId) : null,
      };
      peers.set(discoveryKeyHex, peerInfo);
      emit('peer:paired', peerInfo);
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
      const peerInfo = {
        discoveryKey: discoveryKeyHex,
        sessionPublicKey: null,
        role: 'guest',
        pairedAt: Date.now(),
        userData: localUserData,
        autobaseKey: Buffer.isBuffer(keyBuf) ? toHex(keyBuf) : null,
      };
      peers.set(discoveryKeyHex, peerInfo);
      emit('peer:paired', peerInfo);
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
  emit('peer:dropped', { discoveryKey: discoveryKeyHex });
  return true;
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
  acceptInvite,
  listPeers,
  dropPeer,
  on,
  close,
};
