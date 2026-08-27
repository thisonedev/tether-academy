const Hyperswarm = require('hyperswarm');
const BlindPairing = require('blind-pairing');
const Protomux = require('protomux');
const c = require('compact-encoding');
const crypto = require('crypto');
const hypercoreCrypto = require('hypercore-crypto');
const { EventEmitter } = require('events');
const path = require('path');
const process = require('process');
const pairingCode = require('./pairing-code.cjs');
const auditStore = require('./audit-store.cjs');
const {
  createPairingAttemptGate,
  DEFAULT_MAX_ATTEMPTS: MAX_PAIRING_CODE_ATTEMPTS,
} = require('./pairing-attempt-gate.cjs');
const { createExecHost, STALE_RUN_MS } = require('./exec-host.cjs');
const { isAllowed: rateAllow, reset: rateReset, GLOBAL_KEY } = require('./rate-limit.cjs');
const {
  isSafeExecFileName,
  sanitizeExecFileName,
  sanitizeExecArgv,
  sanitizeExecCode,
  MAX_EXEC_ARGV,
} = require('./exec-validate.cjs');
const { deriveSwarmSeed, PEER_SWARM_INFO } = require('./swarm-seed.cjs');
const identityHandshake = require('./identity-handshake.cjs');
const { createVerification, createRevocation } = require('./verification.cjs');

const AUDIT_CAP = 1000;
// Self-reported peer string for compatibility display only; not a trust check.
const BUILD_ID = 'tether-academy-desktop';
const EXEC_PROTOCOL = 'academy-exec';
// Longer than the host's own STALE_RUN_MS, so its force-kill-and-reply has
// time to land here first; a dropped reply just means one extra retry.
const GUEST_EXEC_STALE_MS = STALE_RUN_MS + 60_000;
let _testGuestExecStaleMs = null;
function guestExecStaleMs() {
  return _testGuestExecStaleMs ?? GUEST_EXEC_STALE_MS;
}
const PROFILE_KIND = 'peer-profile';
// A profile frame is a name plus a few short fields; anything larger is exec
// output that happens to contain the marker string.
const MAX_PROFILE_FRAME_BYTES = 4096;
const HEX_64 = /^[0-9a-fA-F]{64}$/;

function isProfileFrame(buf) {
  if (!buf || buf.length > MAX_PROFILE_FRAME_BYTES) return false;
  const head = Buffer.from(buf).subarray(0, Math.min(buf.length, 32)).toString('utf8');
  return head.includes(`"${PROFILE_KIND}"`);
}

// Only the fields the UI actually reads, each bounded; anything else in the
// frame is dropped rather than stored.
function sanitizeProfileUserData(userData) {
  if (!userData || typeof userData !== 'object') return null;
  const name = typeof userData.name === 'string' ? userData.name.slice(0, 200) : null;
  if (!name) return null;
  return {
    name,
    app: typeof userData.app === 'string' ? userData.app.slice(0, 200) : null,
    // Self-reported, same trust level as `name`: lets the other side's peer
    // picker flag a Windows peer as execute-only, nothing more.
    os: typeof userData.os === 'string' ? userData.os.slice(0, 40) : null,
    buildId: typeof userData.buildId === 'string' ? userData.buildId.slice(0, 200) : null,
    devicePublicKey: typeof userData.devicePublicKey === 'string' && HEX_64.test(userData.devicePublicKey)
      ? userData.devicePublicKey
      : null,
    // Where to find this peer again without an invite. Derived from their
    // identity, so it is the same on their next run. Self-reported like the
    // rest of this frame: it only says where to knock, never who answers.
    swarmPublicKey: typeof userData.swarmPublicKey === 'string' && HEX_64.test(userData.swarmPublicKey)
      ? userData.swarmPublicKey
      : null,
  };
}

// Re-derive the reply keypair manually: blind-pairing's poll adds the peer to
// its skip cache before approve, so the DHT put would never fire on its own.
const [BLIND_NS_EPHEMERAL, BLIND_NS_REPLY] = hypercoreCrypto.namespace('blind-pairing/dht', 3);
function deriveReplyKeyPair(token) {
  return hypercoreCrypto.keyPair(hypercoreCrypto.hash([BLIND_NS_REPLY, token]));
}

const toHex = (buf) => {
  if (buf == null) return null;
  if (typeof buf === 'string') return buf;
  return Buffer.from(buf).toString('hex');
};

const fromHex = (hex) => Buffer.from(hex, 'hex');

// Falls back to the device key rather than OS username/hostname: a peer's
// display name is self-reported and unverified, so it shouldn't leak local
// machine identity when the profile hasn't picked a username yet.
function defaultDeviceName() {
  const key = localClaim?.devicePublicKey;
  return key ? `device-${key.slice(0, 8)}` : 'Unnamed device';
}

// What this device announces about itself once paired. blind-pairing's
// handshake has no channel for the host to hand the guest its userData, so a
// peer only learns the other side's real name from this frame, sent once the
// exec channel opens. Rebuilt on each invite/accept.
let myProfileUserData = null;
function buildLocalUserData(userDataOpt) {
  myProfileUserData = {
    name: userDataOpt?.name || defaultDeviceName(),
    app: 'tether-academy',
    ...(userDataOpt ?? {}),
    buildId: BUILD_ID,
    devicePublicKey: localClaim?.devicePublicKey ?? null,
    swarmPublicKey: swarm ? toHex(swarm.keyPair.publicKey) : null,
  };
  return myProfileUserData;
}

let swarm = null;
let pairing = null;
// Covers the whole of init(). `pairing` is only assigned at the end, so a call
// arriving before that would build a second swarm on the same seed.
let initPromise = null;
let identity = null;
// The two interpreters an exec child can run on, resolved by main: a Bare
// worker has neither process.execPath nor createRequire to find them with.
let execPath = null;
let bareRuntimeBinPath = null;
let userData = null;
// How main seals the identity record at rest. Null until init() reports one.
let secretScheme = null;
// Device keypair for answering identity challenges, plus what this device
// announces about itself. Both derived in init().
let signingKeyPair = null;
let localClaim = null;
// Trust-decision collaborators, instantiated in init() once their collaborators exist.
let revocation = null;
let verification = null;
// Bridges exec-host.cjs's security scan to main's chat.cjs over RPC; set by initOnce below.
let runSecurityScanImpl = null;
let fetchModelsImpl = null;

const members = new Map();
const candidates = new Map();
const peers = new Map();
const pendingRequests = new Map();
const pendingByDiscovery = new Set();
const pendingByInvite = new Set();
const auditLog = [];
const listeners = new Set();
const execChannels = new Map();
// Buffered pairing responses, flushed when the exec channel opens.
const pendingPairingResponses = new Map();
// discoveryKeyHex -> in-flight identity handshake. See identity-handshake.cjs.
const identitySessions = new Map();
// Real userData a peer-profile frame delivered before finalizePair ran for
// that discoveryKey; applied once the peer entry exists. See sendProfileFrame.
const pendingProfiles = new Map();

// Test-only flags. Never set in production.
let _testSkipDhtPut = false;
let _testSkipBlindPairingChannel = false;

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
  // Fire-and-forget: a pairing must never wait on disk.
  try { auditStore.append(entry); } catch { /* logged in audit-store */ }
  emit('peer:audit', entry);
}

function safeParseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return { raw: str };
  }
}

const execHost = createExecHost({
  sendReply: (discoveryKeyHex, payload) => sendExecReply(discoveryKeyHex, payload),
  appendAudit: (type, payload) => appendAudit(type, payload),
  emit: (event, payload) => emit(event, payload),
  getPeerUserData: (discoveryKeyHex) => peers.get(discoveryKeyHex)?.userData ?? null,
  getExecPath: () => execPath,
  getBareRuntimeBinPath: () => bareRuntimeBinPath,
  // Override needed because the default path disagrees with reality when the
  // app was launched with `--storage`, and the capability deny list names this path.
  getUserData: () => userData,
  getSecretScheme: () => secretScheme,
  getRevokedDeviceKey: (discoveryKeyHex) => {
    if (!revocation) return null;
    return revocation.getRevokedDeviceKey(discoveryKeyHex);
  },
  awaitDeviceVerified: (discoveryKeyHex, timeoutMs) => {
    if (!verification) return Promise.resolve({ ok: false, reason: 'no-peer' });
    return verification.awaitPeerVerification(discoveryKeyHex, timeoutMs);
  },
  // Reads the variable at call time; execHost is built before initOnce sets it.
  runSecurityScan: (payload) => {
    if (!runSecurityScanImpl) return Promise.reject(new Error('security scan not configured'));
    return runSecurityScanImpl(payload);
  },
  fetchModels: (payload) => {
    if (!fetchModelsImpl) return Promise.resolve(null);
    return fetchModelsImpl(payload);
  },
});

function init(opts) {
  if (pairing) return Promise.resolve(pairing);
  if (!initPromise) {
    initPromise = initOnce(opts).catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

async function initOnce({
  store,
  bootstrap = null,
  deviceIdentity = null,
  execPath: execPathOpt = null,
  bareRuntimeBinPath: bareRuntimeBinPathOpt = null,
  secretScheme: secretSchemeOpt = null,
  attestation = null,
  revokedDevices: revokedOpt = null,
  auditPath: auditPathOpt = null,
  userData: userDataOpt = null,
  runSecurityScan: runSecurityScanOpt = null,
  fetchModels: fetchModelsOpt = null,
}) {
  if (execPathOpt) execPath = execPathOpt;
  if (bareRuntimeBinPathOpt) bareRuntimeBinPath = bareRuntimeBinPathOpt;
  if (secretSchemeOpt) secretScheme = secretSchemeOpt;
  if (typeof userDataOpt === 'string' && userDataOpt) userData = userDataOpt;
  if (typeof runSecurityScanOpt === 'function') runSecurityScanImpl = runSecurityScanOpt;
  if (typeof fetchModelsOpt === 'function') fetchModelsImpl = fetchModelsOpt;
  revocation = createRevocation({ peers, pendingRequests, appendAudit, dropPeer, reject });
  verification = createVerification({
    identityHandshake,
    getSigningKeyPair: () => signingKeyPair,
    peers,
    identitySessions,
    sendIdentityFrame,
    isRevokedDevice: (key) => revocation.isRevokedDevice(key),
    emit,
    appendAudit,
    dropPeer,
  });
  if (Array.isArray(revokedOpt)) revocation.setRevokedDevices(revokedOpt);
  if (typeof auditPathOpt === 'string' && auditPathOpt) {
    // Seed the ring from the durable file so a post-restart view is honest.
    auditStore.init(auditPathOpt);
    try {
      const seeded = auditStore.readTail(AUDIT_CAP);
      if (seeded.length > 0) {
        auditLog.length = 0;
        for (const entry of seeded) auditLog.push(entry);
      }
    } catch (err) {
      console.warn('[peer] audit seed failed:', err?.message ?? err);
    }
  }
  if (!deviceIdentity) {
    throw new Error('peer.init: device identity is required');
  }
  const device = deviceIdentity;
  identity = device;

  if (!identity.privateKey) {
    throw new Error('peer.init: device private material is required to seed the swarm');
  }

  signingKeyPair = identityHandshake.deriveSigningKeyPair(identity.privateKey);
  const localDevicePublicKey = toHex(signingKeyPair.publicKey);
  if (localDevicePublicKey !== identity.publicKey) {
    console.warn(
      '[peer] device private material does not derive the advertised public key; ' +
        'peers will see this device as unverified',
    );
  }
  // A proof only counts when it attests the key this device can actually sign
  // with, so the attestation is dropped if main hands over a mismatched pair.
  const attests =
    attestation?.proof && attestation.devicePublicKey === localDevicePublicKey ? attestation : null;
  localClaim = {
    devicePublicKey: localDevicePublicKey,
    identityPublicKey: attests?.identityPublicKey ?? null,
    proof: attests?.proof ?? null,
  };

  // Seed from device private material (HKDF), never a public identity key.
  const seed = deriveSwarmSeed(identity.privateKey, PEER_SWARM_INFO);
  swarm = bootstrap ? new Hyperswarm({ seed, bootstrap }) : new Hyperswarm({ seed });

  // Bootstrap runs in the background rather than being awaited: doing so
  // delayed every IPC call behind init(), 8s offline before the UI could paint.
  const BOOTSTRAP_MS = 8_000;
  Promise.race([
    swarm.dht.fullyBootstrapped(),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('dht bootstrap timeout')), BOOTSTRAP_MS);
    }),
  ]).catch((err) => {
    console.warn('[peer] DHT bootstrap incomplete, continuing anyway:', err?.message ?? err);
  });
  pairing = new BlindPairing(swarm, { poll: 30_000 });

  appendAudit('peer:swarm-seed', {
    scheme: 'hkdf-sha256-v1',
    info: PEER_SWARM_INFO,
    note:
      'Swarm Noise key derived from private material; prior public-key-seeded ' +
      'DHT identity is obsolete — re-pair if connections fail after upgrade',
  });

  console.log(
    `[peer] ready, identity pubkey ${identity.publicKey.slice(0, 16)}..., ` +
      `swarm pubkey ${toHex(swarm.keyPair.publicKey).slice(0, 16)}... ` +
      `(seed=hkdf-private-v1)`,
  );

  swarm.on('connection', onSwarmConnection);

  return pairing;
}

function onSwarmConnection(conn) {
  const mux = Protomux.from(conn);
  for (const ref of pairing.active.values()) {
    if (ref.discoveryKey) attachExecProtocol(mux, ref.discoveryKey);
  }
}

function attachExecToAllConnections(discoveryKey) {
  for (const conn of swarm.connections) {
    const mux = Protomux.from(conn);
    attachExecProtocol(mux, discoveryKey);
  }
}

function attachExecProtocol(mux, discoveryKey) {
  const discoveryKeyHex = toHex(discoveryKey);
  const existing = execChannels.get(discoveryKeyHex);
  if (existing?.channel) return;
  const channelOpts = {
    protocol: EXEC_PROTOCOL,
    id: discoveryKey,
    messages: [
      { encoding: c.buffer, onmessage: (buf) => routeExecMessage(discoveryKeyHex, buf) },
    ],
    onclose: () => {
      if (peers.has(discoveryKeyHex)) {
        dropPeer(discoveryKeyHex).catch(() => {});
      }
      if (execChannels.get(discoveryKeyHex)?.channel?.onclose === channelOpts.onclose) {
        execChannels.delete(discoveryKeyHex);
      }
    },
  };
  mux.pair({ protocol: EXEC_PROTOCOL, id: discoveryKey }, () => {
    if (execChannels.get(discoveryKeyHex)?.channel) return;
    const ch = mux.createChannel(channelOpts);
    if (!ch) return;
    execChannels.set(discoveryKeyHex, { channel: ch, mux });
    ch.open();
    flushPendingPairingResponse(discoveryKeyHex);
    startIdentityHandshake(discoveryKeyHex);
    sendProfileFrame(discoveryKeyHex);
  });
  if (!members.has(discoveryKeyHex)) return;
  const ch = mux.createChannel(channelOpts);
  if (!ch) return;
  execChannels.set(discoveryKeyHex, { channel: ch, mux });
  ch.open();
  flushPendingPairingResponse(discoveryKeyHex);
  startIdentityHandshake(discoveryKeyHex);
  sendProfileFrame(discoveryKeyHex);
}

function routeExecMessage(discoveryKeyHex, buf) {
  // Pairing-wake may arrive before the peer entry exists; route it before the lookup.
  if (isPairingWake(buf)) {
    triggerPairingPoll(discoveryKeyHex);
    return;
  }
  // Check before peers.get: the candidate may not have a peer entry yet.
  const head = Buffer.from(buf).subarray(0, Math.min(buf.length, 64)).toString('utf8');
  if (head.includes('"pairing-response"')) {
    try {
      const msg = JSON.parse(Buffer.from(buf).toString('utf8'));
      if (msg && msg.kind === 'pairing-response' && msg.response) {
        handlePairingResponse(discoveryKeyHex, Buffer.from(msg.response, 'base64'));
        return;
      }
    } catch {}
  }
  // Also before peers.get: the handshake channel can open ahead of the peer entry.
  if (identityHandshake.isIdentityFrame(buf)) {
    // Rate-limit the wire side, not the verifier; dropPeer resets this same
    // discovery-key identifier, so teardown needs no separate handling.
    if (!rateAllow('identity:frame', discoveryKeyHex)) return;
    try {
      const msg = JSON.parse(Buffer.from(buf).toString('utf8'));
      if (msg?.kind === identityHandshake.HELLO_KIND || msg?.kind === identityHandshake.PROOF_KIND) {
        verification.handleIdentityFrame(discoveryKeyHex, msg);
        return;
      }
    } catch {}
  }
  // Display-only, like the pending-request userData above; carries no trust
  // decision, so a malformed or oversized frame is just dropped, not audited.
  if (isProfileFrame(buf)) {
    if (!rateAllow('peer-profile:frame', discoveryKeyHex)) return;
    try {
      const msg = JSON.parse(Buffer.from(buf).toString('utf8'));
      const remoteUserData = sanitizeProfileUserData(msg?.userData);
      if (msg?.kind === PROFILE_KIND && remoteUserData) {
        applyRemoteProfile(discoveryKeyHex, remoteUserData);
        return;
      }
    } catch {}
  }
  const peer = peers.get(discoveryKeyHex);
  if (!peer) return;
  if (peer.role === 'host') {
    handleExecRequest(discoveryKeyHex, buf);
  } else {
    handleExecReply(discoveryKeyHex, buf);
  }
}

function isPairingWake(buf) {
  if (!buf) return false;
  // Pre-check the head so large stdout chunks skip JSON.parse.
  const head = Buffer.from(buf).subarray(0, Math.min(buf.length, 32)).toString('utf8');
  if (!head.includes('"pairing-wake"')) return false;
  try {
    const msg = JSON.parse(Buffer.from(buf).toString('utf8'));
    return msg && msg.kind === 'pairing-wake';
  } catch {
    return false;
  }
}

function triggerPairingPoll(discoveryKeyHex) {
  const candidate = candidates.get(discoveryKeyHex);
  if (!candidate || typeof candidate._poll !== 'function') return;
  // _poll is fire-and-forget; errors are swallowed inside blind-pairing.
  Promise.resolve(candidate._poll()).catch(() => {});
}

function sendPairingWake(discoveryKeyHex) {
  const entry = execChannels.get(discoveryKeyHex);
  if (!entry?.channel) return false;
  const msg = entry.channel.messages?.[0];
  if (!msg) return false;
  try {
    msg.send(Buffer.from(JSON.stringify({ kind: 'pairing-wake' }), 'utf8'));
    return true;
  } catch (err) {
    console.warn('[peer] pairing-wake send failed:', err?.message ?? err);
    return false;
  }
}

function sendPairingResponse(discoveryKeyHex, response) {
  const entry = execChannels.get(discoveryKeyHex);
  if (!entry?.channel) return false;
  const msg = entry.channel.messages?.[0];
  if (!msg) return false;
  try {
    const payload = JSON.stringify({
      kind: 'pairing-response',
      response: Buffer.from(response).toString('base64'),
    });
    msg.send(Buffer.from(payload, 'utf8'));
    return true;
  } catch (err) {
    console.warn('[peer] pairing-response send failed:', err?.message ?? err);
    return false;
  }
}

function flushPendingPairingResponse(discoveryKeyHex) {
  const buffered = pendingPairingResponses.get(discoveryKeyHex);
  if (!buffered) return;
  if (sendPairingResponse(discoveryKeyHex, buffered)) {
    pendingPairingResponses.delete(discoveryKeyHex);
  }
}

function handlePairingResponse(discoveryKeyHex, responseBuf) {
  const candidate = candidates.get(discoveryKeyHex);
  if (!candidate) return;
  candidate._addResponse(responseBuf, false).catch(() => {});
}

function sendIdentityFrame(discoveryKeyHex, frame) {
  const msg = execChannels.get(discoveryKeyHex)?.channel?.messages?.[0];
  if (!msg) return false;
  try {
    msg.send(Buffer.from(JSON.stringify(frame), 'utf8'));
    return true;
  } catch (err) {
    console.warn('[peer] identity frame send failed:', err?.message ?? err);
    return false;
  }
}

function sendProfileFrame(discoveryKeyHex) {
  if (!myProfileUserData) return false;
  const msg = execChannels.get(discoveryKeyHex)?.channel?.messages?.[0];
  if (!msg) return false;
  try {
    msg.send(Buffer.from(JSON.stringify({ kind: PROFILE_KIND, userData: myProfileUserData }), 'utf8'));
    return true;
  } catch (err) {
    console.warn('[peer] profile frame send failed:', err?.message ?? err);
    return false;
  }
}

// Corrects the finalizePair-time placeholder with the peer's real userData.
// Can arrive before finalizePair runs on this side, so it's held until then.
function applyRemoteProfile(discoveryKeyHex, remoteUserData) {
  const peer = peers.get(discoveryKeyHex);
  if (!peer) {
    pendingProfiles.set(discoveryKeyHex, remoteUserData);
    return;
  }
  peer.userData = remoteUserData;
  emit('peer:paired', peer);
}

// Runs on channel open, not pairing completion: the ordering differs between
// host and guest, and a nonce costs nothing to hold.
function startIdentityHandshake(discoveryKeyHex) {
  if (!localClaim || identitySessions.has(discoveryKeyHex)) return;
  const session = {
    nonce: identityHandshake.newNonce(),
    remote: null,
    verifiedDevicePublicKey: null,
    verifiedIdentityPublicKey: null,
    applied: false,
  };
  identitySessions.set(discoveryKeyHex, session);
  sendIdentityFrame(discoveryKeyHex, identityHandshake.buildHello(session.nonce, localClaim));
}

function ensureReady() {
  if (!pairing) throw new Error('peer not initialized; call peer.init first');
}

// Public fields only; never expose privateKey / seed to renderer IPC.
function getIdentity() {
  if (!identity) return null;
  return {
    publicKey: identity.publicKey,
    createdAt: identity.createdAt ?? null,
    identityPublicKey: identity.identityPublicKey ?? null,
    source: identity.source ?? null,
  };
}

function finalizePair(discoveryKeyHex, role, userData, autobaseKey, inviteId, hostIdentity) {
  const peerInfo = {
    discoveryKey: discoveryKeyHex,
    sessionPublicKey: null,
    role,
    pairedAt: Date.now(),
    userData,
    autobaseKey: toHex(autobaseKey),
    inviteId: inviteId ?? null,
    // What the other side said it was. Unverified until the handshake lands.
    hostIdentity: role === 'guest' ? hostIdentity ?? null : null,
    identityVerified: false,
    verifiedDevicePublicKey: null,
    verifiedIdentityPublicKey: null,
  };
  peers.set(discoveryKeyHex, peerInfo);
  // A profile frame may have already arrived on this channel; corrects the
  // live entry only, leaving the audit below showing what was known then.
  const pendingProfile = pendingProfiles.get(discoveryKeyHex);
  if (pendingProfile) {
    peerInfo.userData = pendingProfile;
    pendingProfiles.delete(discoveryKeyHex);
  }
  appendAudit('peer:paired', {
    discoveryKey: discoveryKeyHex,
    role,
    remoteUserData: userData,
  });
  emit('peer:paired', peerInfo);
  // The handshake may have finished while this pair was still being set up.
  verification.applyIdentityResult(discoveryKeyHex);
  return peerInfo;
}

async function createInvite({ userData = null, autoApprove = false, code = null } = {}) {
  ensureReady();
  buildLocalUserData(userData);
  const autobaseKey = crypto.randomBytes(32);
  const { invite, publicKey, discoveryKey } = BlindPairing.createInvite(autobaseKey);
  const sessionPublicKey = toHex(publicKey);
  const discoveryKeyHex = toHex(discoveryKey);
  const expectedCode = code || pairingCode.generate();

  // Wrong-code counter for this invite only.
  const codeGate = createPairingAttemptGate({ maxAttempts: MAX_PAIRING_CODE_ATTEMPTS });

  const member = pairing.addMember({
    discoveryKey,
    async onadd(candidate) {
      // Cheap check first: an invalidated invite stays closed without
      // touching the global rate-limit budget.
      if (codeGate.invalidated) {
        candidate._denied = true;
        return;
      }
      if (!rateAllow('pairing:attempt', GLOBAL_KEY)) {
        candidate._denied = true;
        appendAudit('peer:rejected', {
          discoveryKey: discoveryKeyHex,
          reason: 'pairing-global-budget',
        });
        return;
      }

      candidate.open(publicKey);
      const remoteUserData = candidate.userData
        ? safeParseJson(Buffer.from(candidate.userData).toString('utf8'))
        : null;
      const inviteIdHex = candidate.inviteId ? toHex(candidate.inviteId) : null;
      const enteredCode = remoteUserData && typeof remoteUserData === 'object'
        ? (remoteUserData.pairingCode ?? null)
        : null;
      const codeMatches = enteredCode && pairingCode.equal(enteredCode, expectedCode);
      // buildId is self-reported; treat as a compatibility flag only.
      const remoteBuildId = remoteUserData && typeof remoteUserData === 'object'
        ? (remoteUserData.buildId ?? null)
        : null;
      const buildCompatible =
        typeof remoteBuildId === 'string' && remoteBuildId === BUILD_ID;

      if (!codeMatches) {
        candidate._denied = true;
        const outcome = codeGate.recordFailure();
        if (outcome === 'backoff') return;

        // Log the mismatch, never the code itself (renderer-visible stream).
        appendAudit('peer:rejected', {
          discoveryKey: discoveryKeyHex,
          reason: 'pairing-code-mismatch',
          attempts: codeGate.attempts,
        });

        if (outcome === 'lockout') {
          appendAudit('peer:rejected', {
            discoveryKey: discoveryKeyHex,
            reason: 'pairing-code-lockout',
            attempts: codeGate.attempts,
          });
          await member.close().catch(() => {});
          members.delete(discoveryKeyHex);
        }
        return;
      }

      // Self-reported, so a revoked device can omit it; the check that counts
      // runs once the handshake proves which key is on the wire. This one just
      // keeps the honest case off a human's approve button.
      const claimedDeviceKey = remoteUserData && typeof remoteUserData === 'object'
        ? (remoteUserData.devicePublicKey ?? null)
        : null;
      if (typeof claimedDeviceKey === 'string' && revocation.isRevokedDevice(claimedDeviceKey)) {
        candidate._denied = true;
        appendAudit('peer:rejected', {
          discoveryKey: discoveryKeyHex,
          reason: 'device-revoked',
          devicePublicKey: claimedDeviceKey,
        });
        return;
      }

      // An invite pasted back into the device that issued it otherwise pairs a
      // device to itself, listing its own name as the peer and sending runs
      // nowhere. Compares the device key, so the same account on a second
      // device still pairs normally.
      if (
        typeof claimedDeviceKey === 'string'
        && localClaim?.devicePublicKey
        && claimedDeviceKey === localClaim.devicePublicKey
      ) {
        candidate._denied = true;
        appendAudit('peer:rejected', {
          discoveryKey: discoveryKeyHex,
          reason: 'self-pairing',
          devicePublicKey: claimedDeviceKey,
        });
        return;
      }

      if (autoApprove) {
        candidate.confirm({ key: autobaseKey });
        finalizePair(discoveryKeyHex, 'host', remoteUserData, autobaseKey, inviteIdHex);
        return;
      }

      // Already paired with this guest; candidate is a retry or duplicate.
      if (peers.has(discoveryKeyHex)) return;

      if (pendingByDiscovery.has(discoveryKeyHex)) return;
      pendingByDiscovery.add(discoveryKeyHex);

      if (inviteIdHex && pendingByInvite.has(inviteIdHex)) return;
      if (inviteIdHex) pendingByInvite.add(inviteIdHex);

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
        expectedPairingCode: expectedCode,
        enteredPairingCode: enteredCode,
        buildCompatible,
        remoteBuildId,
      };
      pendingRequests.set(requestId, pending);
      appendAudit('peer:pending', {
        requestId,
        discoveryKey: discoveryKeyHex,
        remoteUserData,
        buildCompatible,
      });
      emit('peer:pending', {
        requestId,
        discoveryKey: discoveryKeyHex,
        sessionPublicKey,
        inviteId: inviteIdHex,
        userData: remoteUserData,
        receivedAt: pending.receivedAt,
        expectedPairingCode: expectedCode,
        enteredPairingCode: enteredCode,
        buildCompatible,
        remoteBuildId,
      });
    },
  });
  // Before the flush, not after: addMember announces the topic immediately, and
  // a guest connecting during the flush found itself absent from `members`, so
  // neither side ever opened the exec channel.
  members.set(discoveryKeyHex, member);
  await member.flushed();
  attachExecToAllConnections(discoveryKey);

  return {
    invite: Buffer.from(invite).toString('base64'),
    sessionPublicKey,
    discoveryKey: discoveryKeyHex,
    autobaseKey: toHex(autobaseKey),
    userData,
    pairingCode: expectedCode,
    // Root identity when available (multi-device); else device public key.
    hostIdentity: identity?.identityPublicKey ?? identity?.publicKey ?? null,
  };
}

async function approve(requestId) {
  const pending = pendingRequests.get(requestId);
  if (!pending) return false;
  pendingRequests.delete(requestId);
  // Dedupe entries stay past approve, cleared on drop, so the guest's
  // continuous candidate retries don't create a second pending request.
  pending.candidate.confirm({ key: pending.autobaseKey });

  const response = pending.candidate?.response;
  if (response && !_testSkipBlindPairingChannel) {
    const ref = pairing?.active?.get(pending.discoveryKey);
    if (ref?.channels) {
      for (const ch of ref.channels) {
        try {
          ch.messages[1].send(response);
        } catch (err) {
          console.warn('[peer] direct response send failed:', err?.message ?? err);
        }
      }
    }
  }

  // Exec channel fast path; buffer if not open yet, flush on attach.
  if (response) {
    const sent = sendPairingResponse(pending.discoveryKey, response);
    if (!sent) {
      pendingPairingResponses.set(pending.discoveryKey, response);
    }
  }

  // DHT re-drive fallback if direct channels were missed.
  const member = members.get(pending.discoveryKey);
  if (member && !_testSkipDhtPut) {
    try {
      const token = pending.candidate?.token;
      if (response && token) {
        const replyKeyPair = deriveReplyKeyPair(token);
        await member.dht.mutablePut(replyKeyPair, response);
      }
    } catch (err) {
      console.warn('[peer] manual response put failed:', err?.message ?? err);
    }
  }

  // Wake the guest so it polls immediately; no-op if exec channel isn't open.
  sendPairingWake(pending.discoveryKey);

  finalizePair(
    pending.discoveryKey,
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
  pendingByDiscovery.delete(pending.discoveryKey);
  if (pending.inviteId) pendingByInvite.delete(pending.inviteId);
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

function clearAudit() {
  // Clear is appended before the ring wipes, so the durable record names what was removed.
  const removed = auditLog.length;
  auditStore.recordClear('clear-audit', removed);
  auditLog.length = 0;
  emit('peer:audit-cleared', { at: Date.now(), removed });
  return true;
}

function clearPeerAudit(discoveryKey) {
  if (typeof discoveryKey !== 'string' || !discoveryKey) {
    throw new Error('clearPeerAudit: discoveryKey is required');
  }
  let removed = 0;
  for (let i = auditLog.length - 1; i >= 0; i--) {
    if (auditLog[i].discoveryKey === discoveryKey) {
      auditLog.splice(i, 1);
      removed += 1;
    }
  }
  auditStore.recordClear('clear-peer-audit', removed);
  emit('peer:audit-cleared-for-peer', { discoveryKey, at: Date.now(), removed });
  return removed;
}

async function acceptInvite(inviteB64, { userData = null, code = null, hostIdentity = null } = {}) {
  ensureReady();
  if (typeof inviteB64 !== 'string' || inviteB64.length === 0) {
    throw new Error('acceptInvite: invite must be a non-empty base64 string');
  }
  const invite = Buffer.from(inviteB64, 'base64');
  const { discoveryKey } = BlindPairing.decodeInvite(invite);
  const discoveryKeyHex = toHex(discoveryKey);

  // pairingCode is proof of invite knowledge for this one attempt, not part
  // of the profile a peer-profile frame broadcasts later; kept out of
  // buildLocalUserData's return and added on top here instead.
  const localUserData = {
    ...buildLocalUserData(userData),
    pairingCode: code || null,
  };

  const candidate = pairing.addCandidate({
    invite,
    userData: Buffer.from(JSON.stringify(localUserData), 'utf8'),
    async onadd(result) {
      const keyBuf = result?.key;
      // Null, not this device's own userData: blind-pairing tells the guest
      // nothing about the host, so the real name only lands with the profile
      // frame. Passing localUserData here labelled the host with the guest's
      // own name, so a pairing that never got that frame read as paired to
      // yourself instead of as unknown.
      finalizePair(
        discoveryKeyHex,
        'guest',
        null,
        Buffer.isBuffer(keyBuf) ? keyBuf : null,
        null,
        hostIdentity,
      );
    },
  });
  candidates.set(discoveryKeyHex, candidate);
  // Attach before awaiting pairing so the host's pairing-wake has somewhere to land.
  attachExecToAllConnections(discoveryKey);

  appendAudit('peer:pair:sent', { discoveryKey: discoveryKeyHex });

  let timeoutHandle = null;
  try {
    await Promise.race([
      candidate.pairing,
      new Promise((_, reject) => {
        const onClose = () => reject(new Error('pairing closed before completion'));
        candidate.once('close', onClose);
      }),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('pairing timed out after 30 minutes')), 30 * 60_000);
      }),
    ]);
  } catch (err) {
    candidates.delete(discoveryKeyHex);
    try { await candidate.close(); } catch {}
    appendAudit('peer:pair:error', { discoveryKey: discoveryKeyHex, message: err?.message ?? 'pairing failed' });
    throw err;
  } finally {
    // Always clear the 30-min race timer so it doesn't keep the process alive after pairing completes.
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  attachExecToAllConnections(discoveryKey);

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

  execHost.stopFor(discoveryKeyHex);

  const execCh = execChannels.get(discoveryKeyHex);
  if (execCh?.channel) {
    try { execCh.channel.close(); } catch {}
  }
  execChannels.delete(discoveryKeyHex);

  peers.delete(discoveryKeyHex);
  // Clear dedupe entries that approve() leaves in place so a re-pair isn't blocked.
  pendingByDiscovery.delete(discoveryKeyHex);
  if (peer.inviteId) pendingByInvite.delete(peer.inviteId);
  pendingPairingResponses.delete(discoveryKeyHex);
  identitySessions.delete(discoveryKeyHex);
  pendingProfiles.delete(discoveryKeyHex);
  // A mid-run disconnect otherwise leaves this entry behind and wedges the
  // guest until the next pairing; emit before deleting so main's promise
  // settles on a real event rather than a timeout.
  const guestRun = activeGuestExec.get(discoveryKeyHex);
  if (guestRun && clearActiveGuestExec(discoveryKeyHex, guestRun)) {
    guestRun.emitter.emit('error', new Error('peer disconnected'));
    guestRun.emitter.emit('end');
  }
  verification.settleVerificationWaiters(discoveryKeyHex);
  // Without this a re-pair inherits the previous peer's rate-limit tally.
  rateReset(discoveryKeyHex);
  appendAudit('peer:dropped', { discoveryKey: discoveryKeyHex, role: peer.role });
  emit('peer:dropped', { discoveryKey: discoveryKeyHex });
  return true;
}

function handleExecRequest(discoveryKeyHex, buf) {
  let msg;
  try {
    msg = JSON.parse(Buffer.from(buf).toString('utf8'));
  } catch {
    return;
  }
  if (!msg) return;
  if (msg.kind === 'cancel') {
    execHost.cancel(discoveryKeyHex);
    return;
  }
  if (msg.kind !== 'request') return;
  execHost.handleRequest(discoveryKeyHex, msg);
}

function handleExecReply(discoveryKeyHex, buf) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(buf).toString('utf8'));
  } catch {
    return;
  }
  if (!payload) return;
  const active = activeGuestExec.get(discoveryKeyHex);
  if (!active) return;
  // A stale run's delayed reply can arrive after a fresh run already took the
  // slot; drop it instead of misrouting it to that newer run.
  if (payload.runId !== active.runId) return;
  // Any reply proves the peer is still on this run. Without pushing the window
  // back, the timer is a ceiling on total runtime rather than the idle timeout
  // its message describes, and a long model download trips it mid-stream.
  armGuestExecTimer(discoveryKeyHex, active);
  if (payload.kind === 'started') {
    appendAudit('peer:exec:remote-started', {
      discoveryKey: discoveryKeyHex,
      mode: payload.mode ?? null,
      fileName: payload.fileName ?? null,
    });
  } else if (payload.kind === 'chunk') {
    // The stream name comes off the wire; only forward the two values the
    // host actually sends, not an arbitrary emitter key.
    if (payload.stream !== 'stdout' && payload.stream !== 'stderr') return;
    active.emitter.emit(payload.stream, payload.data);
  } else if (payload.kind === 'exit') {
    active.emitter.emit('exit', {
      code: payload.code ?? null,
      signal: payload.signal ?? null,
      cancelled: payload.cancelled === true,
    });
    active.emitter.emit('end');
    clearActiveGuestExec(discoveryKeyHex, active);
    appendAudit('peer:exec:remote-finished', {
      discoveryKey: discoveryKeyHex,
      code: payload.code,
      signal: payload.signal ?? null,
      mode: payload.mode ?? null,
      fileName: payload.fileName ?? null,
    });
  } else if (payload.kind === 'error') {
    active.emitter.emit('error', new Error(payload.message ?? 'exec failed'));
    active.emitter.emit('end');
    clearActiveGuestExec(discoveryKeyHex, active);
    appendAudit('peer:exec:remote-error', {
      discoveryKey: discoveryKeyHex,
      message: payload.message ?? 'exec failed',
      mode: payload.mode ?? null,
      fileName: payload.fileName ?? null,
    });
  }
}

function sendExecReply(discoveryKeyHex, payload) {
  const entry = execChannels.get(discoveryKeyHex);
  if (!entry?.channel) return;
  const msg = entry.channel.messages?.[0];
  if (!msg) return;
  try {
    msg.send(Buffer.from(JSON.stringify(payload), 'utf8'));
  } catch (err) {
    console.warn('[peer] exec reply failed:', err?.message ?? err);
  }
}

const activeGuestExec = new Map();

// Only clears `peerId`'s entry if it's still exactly this one, so a timer
// left over from an abandoned run can't clear a newer one that replaced it.
function clearActiveGuestExec(peerId, expectedEntry) {
  const current = activeGuestExec.get(peerId);
  if (!current || current !== expectedEntry) return false;
  if (current.timer) clearTimeout(current.timer);
  activeGuestExec.delete(peerId);
  return true;
}

// Restarts the idle window. Armed at send time and pushed back by every reply,
// so a run stays alive for as long as the peer keeps talking.
function armGuestExecTimer(peerId, entry) {
  if (activeGuestExec.get(peerId) !== entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    if (!clearActiveGuestExec(peerId, entry)) return;
    entry.emitter.emit('error', new Error(`no reply from peer after ${Math.round(entry.staleMs / 1000)}s`));
    entry.emitter.emit('end');
  }, entry.staleMs);
}

function exec({ peerId, code, mode = 'inline', argv = [], fileName = 'snippet.mts', label = null, declared = null }) {
  if (typeof peerId !== 'string' || !peerId) {
    throw new Error('exec: peerId is required');
  }
  code = sanitizeExecCode(code);
  if (mode !== 'inline' && mode !== 'file') {
    throw new Error(`exec: mode must be 'inline' or 'file', got ${mode}`);
  }
  argv = sanitizeExecArgv(argv);
  fileName = sanitizeExecFileName(fileName);
  if (label != null && (typeof label !== 'string' || label.length > 200)) {
    throw new Error('exec: label must be a string of at most 200 characters');
  }
  const entry = execChannels.get(peerId);
  if (!entry?.channel) {
    throw new Error(`exec: no exec channel for peer ${peerId.slice(0, 16)}...`);
  }
  const msg = entry.channel.messages?.[0];
  if (!msg) {
    throw new Error('exec: channel has no message slot');
  }
  if (activeGuestExec.has(peerId)) {
    throw new Error('exec: another exec is already running on this peer');
  }
  const emitter = new EventEmitter();
  // Tags every reply for this run, so a stale run's late reply can't be
  // mistaken for this one once a later exec has replaced it in the map.
  const runId = crypto.randomUUID();
  const guestEntry = { emitter, timer: null, runId, staleMs: guestExecStaleMs() };
  activeGuestExec.set(peerId, guestEntry);
  armGuestExecTimer(peerId, guestEntry);
  try {
    // No cwd on the wire: the host recomputes it from the lesson path,
    // since a renderer-supplied value would be dead by the time it lands.
    msg.send(Buffer.from(JSON.stringify({ kind: 'request', runId, code, mode, argv, fileName, label, declared }), 'utf8'));
  } catch (err) {
    clearActiveGuestExec(peerId, guestEntry);
    throw err;
  }
  return emitter;
}

function cancelExec(peerId) {
  if (typeof peerId !== 'string' || !peerId) {
    throw new Error('cancelExec: peerId is required');
  }
  if (!activeGuestExec.has(peerId)) return false;
  const entry = execChannels.get(peerId);
  if (!entry?.channel) return false;
  const msg = entry.channel.messages?.[0];
  if (!msg) return false;
  try {
    msg.send(Buffer.from(JSON.stringify({ kind: 'cancel' }), 'utf8'));
    return true;
  } catch (err) {
    console.warn('[peer] cancelExec send failed:', err?.message ?? err);
    return false;
  }
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
  execHost.stopAll();
  for (const entry of execChannels.values()) {
    if (entry.channel) {
      try { entry.channel.close(); } catch {}
    }
  }
  members.clear();
  candidates.clear();
  // Snapshot before clear() so the rate-limit reset below still has the keys.
  const peerKeys = Array.from(peers.keys());
  peers.clear();
  verification?.settleAllWaiters();
  pendingRequests.clear();
  execChannels.clear();
  activeGuestExec.clear();
  identitySessions.clear();
  // Global windows (rpc:command, pairing:attempt) keep their state.
  for (const key of peerKeys) rateReset(key);
  auditLog.length = 0;
  listeners.clear();
  auditStore.close();
  if (pairing) await pairing.close().catch(() => {});
  if (swarm) await swarm.destroy().catch(() => {});
  pairing = null;
  initPromise = null;
  swarm = null;
  identity = null;
  signingKeyPair = null;
  localClaim = null;
  revocation = null;
  verification = null;
}

module.exports = {
  init,
  getIdentity,
  createInvite,
  approve,
  reject,
  listPending,
  resolveDeviceRequest: (requestId, approved) => execHost.resolveDeviceRequest(requestId, approved),
  listDeviceRequests: () => execHost.listDeviceRequests(),
  getAudit,
  acceptInvite,
  listPeers,
  dropPeer,
  setRevokedDevices: (keys) => revocation.setRevokedDevices(keys),
  // Kept on the module so existing tests don't have to import verification.cjs directly.
  claimMatches: (claimed, remote) => verification.claimMatches(claimed, remote),
  peerVerification: (discoveryKeyHex) => verification.peerVerification(discoveryKeyHex),
  lockdown,
  exec,
  cancelExec,
  clearAudit,
  clearPeerAudit,
  on,
  close,
  isSafeExecFileName,
  MAX_PAIRING_CODE_ATTEMPTS,
  BUILD_ID,
  // Test-only. Not for production.
  // autoApprove/code stay on createInvite for tests; main/preload never forward them.
  _testHooks: {
    setSkipDhtPut(value) { _testSkipDhtPut = !!value; },
    setSkipBlindPairingChannel(value) { _testSkipBlindPairingChannel = !!value; },
    setGuestExecStaleMs(value) { _testGuestExecStaleMs = value; },
    setStaleRunMs(value) { require('./exec-host.cjs')._setTestStaleRunMs(value); },
  },
};
