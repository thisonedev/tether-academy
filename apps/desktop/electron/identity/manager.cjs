// Root + device identity (keet-identity-key). Sources: 'tether-academy'
// (default) or 'keet-linked' (QR/attest only).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hypercoreCrypto = require('hypercore-crypto');
const IdentityKey = require('keet-identity-key');
const b4a = require('b4a');
const {
  createSecretStorage,
  wipeStringRef,
} = require('../secret-storage.cjs');
const {
  BLOB_FILE_PRIVATE,
  attestPayload,
  verifyPayload,
  createStore: createBlobStore,
} = require('./attested-blob-store.cjs');
const { publicStoreFromIdentity } = require('./profile-publish.cjs');

const RECORD_FILE = 'identity-v3.json';
const RECORD_VERSION = 3;

const HEX_64 = /^[0-9a-fA-F]{64}$/;
const TRUSTED_PEERS_KIND = 'trusted-peers';
// The blob is rewritten whole on every change, so the list stays bounded.
const MAX_TRUSTED_PEERS = 100;

function hexOrNull(value) {
  return typeof value === 'string' && HEX_64.test(value) ? value : null;
}
// Attest sessions age out rather than staying confirmable indefinitely for a caller that never returns.
const ATTEST_SESSION_TTL_MS = 10 * 60_000;

/** @typedef {'none'|'pending-backup'|'ready'} IdentityStatus */

function toHex(buf) {
  if (buf == null) return null;
  if (typeof buf === 'string') return buf;
  return Buffer.from(buf).toString('hex');
}

function fromHex(hex) {
  return Buffer.from(hex, 'hex');
}

function generateDeviceKeyPair() {
  return hypercoreCrypto.keyPair();
}

function keyPairFromHex(publicKeyHex, secretKeyHex) {
  return {
    publicKey: fromHex(publicKeyHex),
    secretKey: fromHex(secretKeyHex),
  };
}

function createManager(userDataDir, opts = {}) {
  const secrets = opts.secretStorage || createSecretStorage(userDataDir, opts);
  const recordPath = path.join(userDataDir, RECORD_FILE);
  const attestSessionTtlMs = opts.attestSessionTtlMs ?? ATTEST_SESSION_TTL_MS;

  /** @type {object | null} */
  let record = null;
  /** In-memory secrets (never written plaintext). */
  let deviceSecretKeyHex = null;
  let rootSeedHex = null;
  /** Stores keyed by `kind`, lazily created once identity is ready. */
  let privateBlobStore = null;
  let publicBlobStore = null;
  let deviceKeyPair = null;
  /** Pending create: mnemonic shown once until confirmBackup. */
  let pendingMnemonic = null;
  /** Host-side attest sessions awaiting explicit confirm. */
  const attestSessions = new Map();

  function loadRecordFromDisk() {
    if (!fs.existsSync(recordPath)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      if (!raw || raw.version !== RECORD_VERSION) return null;
      return raw;
    } catch {
      return null;
    }
  }

  function persistRecord() {
    if (!record) return;
    fs.mkdirSync(userDataDir, { recursive: true });
    const tmp = `${recordPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, recordPath);
    try {
      fs.chmodSync(recordPath, 0o600);
    } catch {
      // Windows may ignore
    }
  }

  function hydrateSecrets() {
    if (!record) return;
    if (record.devicePrivateKeyEnc) {
      deviceSecretKeyHex = secrets.decryptString(record.devicePrivateKeyEnc);
    }
    if (record.rootSeedEnc) {
      rootSeedHex = secrets.decryptString(record.rootSeedEnc);
    }
  }

  async function loadBlobStores() {
    privateBlobStore = null;
    publicBlobStore = null;
    deviceKeyPair = null;
    if (!record || !deviceSecretKeyHex || !record.devicePublicKey) return;
    deviceKeyPair = keyPairFromHex(record.devicePublicKey, deviceSecretKeyHex);
    const blobPath = path.join(userDataDir, BLOB_FILE_PRIVATE);
    const openPrivateStore = () => createBlobStore({
      filePath: blobPath,
      encrypt: (buf) => secrets.encryptString(buf.toString('utf8')),
      decrypt: (buf) => Buffer.from(secrets.decryptString(buf.toString('utf8')), 'utf8'),
      identityPublicKey: record.identityPublicKey,
    });
    try {
      privateBlobStore = openPrivateStore();
    } catch (err) {
      if (!/identity mismatch/.test(err.message)) throw err;
      // Stale blob from a prior identity (resetLocal keeps it for same-mnemonic
      // recovery). Move it aside instead of failing this identity's setup.
      try {
        fs.renameSync(blobPath, `${blobPath}.stale-${Date.now()}`);
      } catch {
        // ignore
      }
      privateBlobStore = openPrivateStore();
    }
    // Only available with the root seed (tether-academy devices); keet-linked
    // devices can't derive the discovery key, so they're read-only here.
    if (rootSeedHex) {
      try {
        const id = await IdentityKey.from({ seed: fromHex(rootSeedHex) });
        publicBlobStore = publicStoreFromIdentity({
          identity: id,
          userDataDir,
        });
        id.clear();
      } catch {
        publicBlobStore = null;
      }
    }
  }

  // Kept so the caller can tell a startup failure apart from "never onboarded",
  // which look identical from status() alone.
  /** @type {Error | null} */
  let lastInitError = null;

  // Resolves once init() has loaded the blob stores, so IPC handlers can
  // await it and avoid racing the async hydrate; create/recover re-resolve it.
  let readyPromise = null;
  function ready() {
    if (!readyPromise) {
      readyPromise = (async () => {
        await init();
        return true;
      })();
    }
    return readyPromise;
  }

  async function init() {
    try {
      record = loadRecordFromDisk();
      if (record) {
        hydrateSecrets();
        await loadBlobStores();
      }
      lastInitError = null;
    } catch (err) {
      lastInitError = err;
      throw err;
    }
  }

  function reapAttestSessions() {
    const now = Date.now();
    for (const [sessionId, session] of attestSessions) {
      if (now - session.createdAt > attestSessionTtlMs) attestSessions.delete(sessionId);
    }
  }

  function status() {
    if (!record) return 'none';
    if (!record.proof || !record.devicePublicKey) return 'none';
    if (record.source === 'tether-academy' && !record.backupConfirmedAt) {
      return 'pending-backup';
    }
    return 'ready';
  }

  function publicView() {
    const st = status();
    if (st === 'none' || !record) {
      return {
        status: st,
        ready: false,
        source: null,
        identityPublicKey: null,
        devicePublicKey: null,
        createdAt: null,
        backupConfirmed: false,
        devices: [],
        holdsRoot: false,
      };
    }
    return {
      status: st,
      ready: st === 'ready',
      source: record.source,
      identityPublicKey: record.identityPublicKey,
      devicePublicKey: record.devicePublicKey,
      createdAt: record.createdAt ?? null,
      backupConfirmed: !!record.backupConfirmedAt,
      holdsRoot: !!record.rootSeedEnc,
      devices: (record.devices || []).map((d) => ({
        publicKey: d.publicKey,
        role: d.role,
        revoked: !!d.revoked,
        attestedAt: d.attestedAt ?? null,
        label: d.label ?? null,
      })),
    };
  }

  // hypercore-crypto secretKey is 64 bytes (seed||pub). Swarm seed uses first 32.
  function getDevicePrivateMaterialHex() {
    if (!deviceSecretKeyHex) return null;
    const buf = fromHex(deviceSecretKeyHex);
    return buf.subarray(0, 32).toString('hex');
  }

  /** Mesh / swarm material: device key only (never root). */
  function getDeviceIdentity() {
    if (status() !== 'ready' || !record || !deviceSecretKeyHex) return null;
    return {
      publicKey: record.devicePublicKey,
      privateKey: getDevicePrivateMaterialHex(),
      secretKey: deviceSecretKeyHex,
      createdAt: record.createdAt ?? null,
      identityPublicKey: record.identityPublicKey,
      source: record.source,
    };
  }

  async function createNew() {
    if (status() === 'ready') {
      throw new Error('identity already ready; revoke/reset is required to replace it');
    }
    const mnemonic = IdentityKey.generateMnemonic();
    const id = await IdentityKey.from({ mnemonic });
    const rootSeed = await IdentityKey.deriveSeed(mnemonic);

    const device = generateDeviceKeyPair();
    const proof = await id.bootstrap(device.publicKey);

    const verified = IdentityKey.verify(proof, null, {
      expectedDevice: device.publicKey,
      expectedIdentity: id.identityPublicKey,
    });
    if (!verified) throw new Error('identity: bootstrap proof failed verification');

    deviceSecretKeyHex = toHex(device.secretKey);
    rootSeedHex = toHex(rootSeed);
    pendingMnemonic = mnemonic;

    record = {
      version: RECORD_VERSION,
      source: 'tether-academy',
      identityPublicKey: toHex(id.identityPublicKey),
      devicePublicKey: toHex(device.publicKey),
      devicePrivateKeyEnc: secrets.encryptString(deviceSecretKeyHex),
      rootSeedEnc: secrets.encryptString(rootSeedHex),
      proof: Buffer.from(proof).toString('base64'),
      devices: [
        {
          publicKey: toHex(device.publicKey),
          role: 'self',
          revoked: false,
          attestedAt: Date.now(),
          label: 'this-device',
        },
      ],
      createdAt: Date.now(),
      backupConfirmedAt: null,
    };
    persistRecord();
    id.clear();
    await loadBlobStores();
    readyPromise = null;

    return {
      mnemonic,
      identityPublicKey: record.identityPublicKey,
      devicePublicKey: record.devicePublicKey,
      source: record.source,
    };
  }

  function confirmBackup() {
    if (!record) throw new Error('identity: nothing to confirm');
    if (record.source !== 'tether-academy') {
      // Keet-linked devices never hold mnemonic in this app.
      record.backupConfirmedAt = Date.now();
      persistRecord();
      pendingMnemonic = null;
      return publicView();
    }
    record.backupConfirmedAt = Date.now();
    persistRecord();
    pendingMnemonic = null;
    return publicView();
  }

  async function recoverFromMnemonic(mnemonic) {
    if (typeof mnemonic !== 'string' || mnemonic.trim().split(/\s+/).length < 12) {
      throw new Error('identity: invalid mnemonic');
    }
    const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
    const id = await IdentityKey.from({ mnemonic: normalized });
    const rootSeed = await IdentityKey.deriveSeed(normalized);
    const device = generateDeviceKeyPair();
    const proof = await id.bootstrap(device.publicKey);
    const verified = IdentityKey.verify(proof, null, {
      expectedDevice: device.publicKey,
      expectedIdentity: id.identityPublicKey,
    });
    if (!verified) throw new Error('identity: recovery bootstrap failed');

    deviceSecretKeyHex = toHex(device.secretKey);
    rootSeedHex = toHex(rootSeed);
    pendingMnemonic = null;

    record = {
      version: RECORD_VERSION,
      source: 'tether-academy',
      identityPublicKey: toHex(id.identityPublicKey),
      devicePublicKey: toHex(device.publicKey),
      devicePrivateKeyEnc: secrets.encryptString(deviceSecretKeyHex),
      rootSeedEnc: secrets.encryptString(rootSeedHex),
      proof: Buffer.from(proof).toString('base64'),
      devices: [
        {
          publicKey: toHex(device.publicKey),
          role: 'self',
          revoked: false,
          attestedAt: Date.now(),
          label: 'recovered',
        },
      ],
      createdAt: Date.now(),
      backupConfirmedAt: Date.now(),
    };
    persistRecord();
    id.clear();
    await loadBlobStores();
    readyPromise = null;
    return publicView();
  }

  // --- Attest host (device that holds root or valid chain) ---

  function beginAttestSession(devicePublicKeyHex, { label } = {}) {
    reapAttestSessions();
    if (status() !== 'ready' || !record) {
      throw new Error('identity: not ready to attest');
    }
    if (!rootSeedHex && !deviceSecretKeyHex) {
      throw new Error('identity: missing keys to attest');
    }
    if (typeof devicePublicKeyHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(devicePublicKeyHex)) {
      throw new Error('identity: devicePublicKey must be 32-byte hex');
    }
    const revoked = (record.devices || []).find(
      (d) => d.publicKey === devicePublicKeyHex && d.revoked,
    );
    if (revoked) throw new Error('identity: device was revoked');

    const sessionId = crypto.randomUUID();
    attestSessions.set(sessionId, {
      sessionId,
      devicePublicKey: devicePublicKeyHex,
      label: label || null,
      createdAt: Date.now(),
      confirmed: false,
    });
    return {
      sessionId,
      devicePublicKey: devicePublicKeyHex,
      identityPublicKey: record.identityPublicKey,
      // UI must show this and require explicit confirm before finishAttest.
      needsConfirm: true,
    };
  }

  async function finishAttest(sessionId, { confirm = false } = {}) {
    if (!confirm) {
      throw new Error('identity: finishAttest requires explicit confirm:true');
    }
    const wasPending = attestSessions.has(sessionId);
    reapAttestSessions();
    if (wasPending && !attestSessions.has(sessionId)) {
      throw new Error('identity: attest session expired');
    }
    const session = attestSessions.get(sessionId);
    if (!session) throw new Error('identity: unknown attest session');

    const existingProof = Buffer.from(record.proof, 'base64');
    const newDevicePub = fromHex(session.devicePublicKey);
    let proof;

    if (rootSeedHex) {
      // Prefer root bootstrap path when we hold the seed (first device).
      const id = await IdentityKey.from({ seed: fromHex(rootSeedHex) });
      const parent = keyPairFromHex(record.devicePublicKey, deviceSecretKeyHex);
      proof = IdentityKey.attestDevice(newDevicePub, parent, existingProof);
      id.clear();
    } else {
      const parent = keyPairFromHex(record.devicePublicKey, deviceSecretKeyHex);
      proof = IdentityKey.attestDevice(newDevicePub, parent, existingProof);
    }

    const info = IdentityKey.verify(proof, null, {
      expectedDevice: newDevicePub,
      expectedIdentity: fromHex(record.identityPublicKey),
    });
    if (!info) throw new Error('identity: produced proof failed verification');

    record.devices = record.devices || [];
    if (!record.devices.some((d) => d.publicKey === session.devicePublicKey)) {
      record.devices.push({
        publicKey: session.devicePublicKey,
        role: 'trusted',
        revoked: false,
        attestedAt: Date.now(),
        label: session.label,
      });
    }
    persistRecord();
    attestSessions.delete(sessionId);

    return {
      proof: Buffer.from(proof).toString('base64'),
      identityPublicKey: record.identityPublicKey,
      devicePublicKey: session.devicePublicKey,
      source: record.source,
    };
  }

  function cancelAttest(sessionId) {
    const existed = attestSessions.delete(sessionId);
    reapAttestSessions();
    return existed;
  }

  function listAttestSessions() {
    reapAttestSessions();
    return Array.from(attestSessions.values()).map((s) => ({
      sessionId: s.sessionId,
      devicePublicKey: s.devicePublicKey,
      label: s.label,
      createdAt: s.createdAt,
    }));
  }

  function revokeDevice(devicePublicKeyHex) {
    if (status() !== 'ready' || !record) throw new Error('identity: not ready');
    if (devicePublicKeyHex === record.devicePublicKey) {
      throw new Error('identity: cannot revoke this device from itself; use reset');
    }
    let found = false;
    for (const d of record.devices || []) {
      if (d.publicKey === devicePublicKeyHex) {
        d.revoked = true;
        d.revokedAt = Date.now();
        found = true;
      }
    }
    if (!found) {
      record.devices.push({
        publicKey: devicePublicKeyHex,
        role: 'trusted',
        revoked: true,
        revokedAt: Date.now(),
        attestedAt: null,
      });
    }
    persistRecord();
    return publicView();
  }

  function isDeviceRevoked(devicePublicKeyHex) {
    if (!record) return false;
    return (record.devices || []).some(
      (d) => d.publicKey === devicePublicKeyHex && d.revoked,
    );
  }

  function getAttestationProof() {
    if (!record?.proof) return null;
    return record.proof;
  }

  /** What this device announces to a peer so the peer can check the binding. */
  function attestation() {
    if (status() !== 'ready' || !record?.proof) return null;
    return {
      proof: record.proof,
      identityPublicKey: record.identityPublicKey,
      devicePublicKey: record.devicePublicKey,
    };
  }

  function revokedDeviceKeys() {
    return (record?.devices || []).filter((d) => d.revoked).map((d) => d.publicKey);
  }

  function resetLocal() {
    wipeStringRef({ v: deviceSecretKeyHex }, 'v');
    wipeStringRef({ v: rootSeedHex }, 'v');
    deviceSecretKeyHex = null;
    rootSeedHex = null;
    pendingMnemonic = null;
    attestSessions.clear();
    record = null;
    privateBlobStore = null;
    publicBlobStore = null;
    deviceKeyPair = null;
    readyPromise = null;
    try {
      if (fs.existsSync(recordPath)) fs.unlinkSync(recordPath);
    } catch {
      // ignore
    }
    // Blob files stay on disk (not deleted): recovering the same mnemonic on
    // this device should find prior progress. Wipe is a per-device decision.
    return { status: 'none' };
  }

  function peekPendingMnemonic() {
    // Only available between createNew and confirmBackup.
    return pendingMnemonic;
  }

  // --- Attested blob store: read/write helpers for both stores ---

  function ensureReady() {
    if (status() !== 'ready') throw new Error('identity: not ready');
    if (!record || !privateBlobStore || !deviceKeyPair) {
      throw new Error('identity: stores not loaded');
    }
  }

  function nextRevision(prev) {
    return typeof prev === 'number' && prev >= 0 ? prev + 1 : 1;
  }

  function writePrivate(kind, payload) {
    ensureReady();
    if (!kind || typeof kind !== 'string') {
      throw new Error('blob: kind must be a non-empty string');
    }
    const prev = privateBlobStore.get(kind);
    const entry = attestPayload({
      kind,
      payload,
      deviceKeyPair,
      currentProofB64: record.proof,
      identityKey: null, // IdentityKey unused when currentProofB64 is set
    });
    entry.revision = nextRevision(prev && prev.revision);
    privateBlobStore.put(kind, entry);
    return entry;
  }

  function readPrivate(kind) {
    ensureReady();
    const entry = privateBlobStore.get(kind);
    if (!entry) return null;
    if (!verifyPayload(entry, {
      IdentityKey,
      expectedIdentityPublicKeyHex: record.identityPublicKey,
    })) {
      // Tampering or proof-chain divergence surfaces as null rather than
      // throwing, so a corrupted kind doesn't take down the whole identity.
      return null;
    }
    return entry;
  }

  function writePublic(kind, payload) {
    ensureReady();
    if (!publicBlobStore) {
      throw new Error('blob: cannot publish on a keet-linked device (no root seed)');
    }
    const prev = publicBlobStore.get(kind);
    const entry = attestPayload({
      kind,
      payload,
      deviceKeyPair,
      currentProofB64: record.proof,
      identityKey: null,
    });
    entry.revision = nextRevision(prev && prev.revision);
    publicBlobStore.put(kind, entry);
    return entry;
  }

  function readPublic(kind) {
    ensureReady();
    if (!publicBlobStore) return null;
    const entry = publicBlobStore.get(kind);
    if (!entry) return null;
    if (!verifyPayload(entry, {
      IdentityKey,
      expectedIdentityPublicKeyHex: record.identityPublicKey,
    })) {
      return null;
    }
    return entry;
  }

  // --- High-level helpers ----------------------------------------------

  const USERNAME_RE = /^[a-z0-9](?:[a-z0-9_-]{1,28}[a-z0-9])?$/i;

  function normalizeUsername(raw) {
    if (typeof raw !== 'string') throw new Error('username: must be a string');
    const trimmed = raw.trim().toLowerCase();
    if (!USERNAME_RE.test(trimmed)) {
      throw new Error('username: 3-30 chars, letters/digits/underscore/dash, no leading or trailing dash or underscore');
    }
    return trimmed;
  }

  function setUsername(rawUsername) {
    ensureReady();
    const username = normalizeUsername(rawUsername);
    const entry = writePrivate('username', { username });
    if (publicBlobStore) {
      try {
        writePublic('username', { username });
      } catch (err) {
        // Don't fail the local set if the publish failed; the user can retry.
        console.error('identity: failed to publish username', err);
      }
    }
    return { username, revision: entry.revision, updatedAt: entry.updatedAt };
  }

  function getUsername() {
    const entry = readPrivate('username');
    if (!entry) return null;
    return {
      username: entry.payload && entry.payload.username,
      revision: entry.revision,
      updatedAt: entry.updatedAt,
      published: !!readPublic('username'),
    };
  }

  // A peer you have paired with, kept across restarts so reconnecting costs a
  // click instead of a fresh invite. Keyed by the device key the handshake
  // proved, never the self-reported name.
  function listTrustedPeers() {
    const entry = readPrivate(TRUSTED_PEERS_KIND);
    const peers = entry?.payload?.peers;
    if (!Array.isArray(peers)) return [];
    return peers.filter((p) => p && HEX_64.test(p.devicePublicKey ?? ''));
  }

  function writeTrustedPeers(peers) {
    // Most recently seen first, so the cap sheds the peers you stopped using
    // rather than whichever happened to be written last.
    const capped = peers
      .slice()
      .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
      .slice(0, MAX_TRUSTED_PEERS);
    const entry = writePrivate(TRUSTED_PEERS_KIND, { peers: capped });
    return { peers: capped, revision: entry.revision, updatedAt: entry.updatedAt };
  }

  /**
   * @param {{ devicePublicKey: string, identityPublicKey?: string|null,
   *   swarmPublicKey?: string|null, name?: string|null }} peer
   */
  function trustPeer(peer) {
    ensureReady();
    const devicePublicKey = String(peer?.devicePublicKey ?? '');
    if (!HEX_64.test(devicePublicKey)) {
      throw new Error('trustPeer: devicePublicKey must be 32 bytes of hex');
    }
    const now = Date.now();
    const existing = listTrustedPeers();
    const prev = existing.find((p) => p.devicePublicKey === devicePublicKey);
    const next = {
      devicePublicKey,
      identityPublicKey: hexOrNull(peer?.identityPublicKey) ?? prev?.identityPublicKey ?? null,
      // How a known peer is found again without an invite. Stable per identity,
      // since the swarm keypair is derived from it.
      swarmPublicKey: hexOrNull(peer?.swarmPublicKey) ?? prev?.swarmPublicKey ?? null,
      name: typeof peer?.name === 'string' && peer.name ? peer.name.slice(0, 80) : prev?.name ?? null,
      trustedAt: prev?.trustedAt ?? now,
      lastSeenAt: now,
      revoked: prev?.revoked === true,
    };
    writeTrustedPeers([next, ...existing.filter((p) => p.devicePublicKey !== devicePublicKey)]);
    return next;
  }

  function untrustPeer(devicePublicKey) {
    ensureReady();
    const before = listTrustedPeers();
    const after = before.filter((p) => p.devicePublicKey !== devicePublicKey);
    if (after.length === before.length) return false;
    writeTrustedPeers(after);
    return true;
  }

  /** Kept in the list rather than removed, so a revoked peer stays refusable. */
  function setTrustedPeerRevoked(devicePublicKey, revoked) {
    ensureReady();
    const peers = listTrustedPeers();
    const target = peers.find((p) => p.devicePublicKey === devicePublicKey);
    if (!target) return false;
    target.revoked = revoked === true;
    writeTrustedPeers(peers);
    return true;
  }

  // Progress is an open per-machine JSON blob keyed by lesson-id; the renderer owns its shape.
  function setProgress(progress) {
    ensureReady();
    if (!progress || typeof progress !== 'object') {
      throw new Error('progress: must be an object');
    }
    const entry = writePrivate('progress', {
      progress,
      updatedAt: Date.now(),
    });
    return {
      progress: entry.payload.progress,
      revision: entry.revision,
      updatedAt: entry.updatedAt,
    };
  }

  function getProgress() {
    const entry = readPrivate('progress');
    if (!entry) return null;
    return {
      progress: entry.payload && entry.payload.progress,
      revision: entry.revision,
      updatedAt: entry.updatedAt,
    };
  }

  // Exposes verifyPayload to the UI, e.g. to confirm a peer's username
  // before saving it to a contact list.
  function verifyAttested(kind, payload, proofB64, expectedIdentityPublicKeyHex) {
    return verifyPayload(
      { kind, payload, proofB64 },
      { IdentityKey, expectedIdentityPublicKeyHex },
    );
  }

  // Verifies a peer's publicProfileSnapshot. Only the plain {payload,
  // proofB64} shape can be checked here; payloadEnc blobs need the peer's
  // discovery key (derived from their seed), which isn't exchanged yet.
  function importProfile({ identityPublicKeyHex, profile }) {
    if (!identityPublicKeyHex || typeof identityPublicKeyHex !== 'string') {
      throw new Error('import-profile: identityPublicKeyHex required');
    }
    if (!profile || typeof profile !== 'object') {
      throw new Error('import-profile: profile object required');
    }
    const blobs = profile.blobs || {};
    const verified = {};
    for (const [kind, entry] of Object.entries(blobs)) {
      if (!entry || typeof entry !== 'object') {
        verified[kind] = false;
        continue;
      }
      if (entry.payload && entry.proofB64) {
        verified[kind] = verifyPayload(
          { kind, payload: entry.payload, proofB64: entry.proofB64 },
          { IdentityKey, expectedIdentityPublicKeyHex: identityPublicKeyHex },
        );
      } else if (entry.payloadEnc) {
        verified[kind] = false;
      } else {
        verified[kind] = false;
      }
    }
    return { ok: true, verified };
  }

  init().catch((err) => {
    console.error('identity: init failed', err);
  });

  return {
    status,
    publicView,
    /** 'safeStorage' or 'aes-gcm-local'. Peer-exec refuses the latter. */
    secretScheme: () => secrets.scheme,
    /** What the last init() threw, or null once one succeeds. */
    initError: () => lastInitError,
    /** Resolves once init() has loaded the blob stores. IPC handlers
     *  await this so renderer calls never race the async hydrate. */
    ready,
    getDeviceIdentity,
    getDevicePrivateMaterialHex,
    createNew,
    confirmBackup,
    recoverFromMnemonic,
    beginAttestSession,
    finishAttest,
    cancelAttest,
    listAttestSessions,
    revokeDevice,
    isDeviceRevoked,
    revokedDeviceKeys,
    getAttestationProof,
    attestation,
    resetLocal,
    peekPendingMnemonic,
    verifyProof(proofB64, expectedDeviceHex) {
      const proof = Buffer.from(proofB64, 'base64');
      const opts = {};
      if (expectedDeviceHex) opts.expectedDevice = fromHex(expectedDeviceHex);
      return IdentityKey.verify(proof, null, opts);
    },
    setUsername,
    getUsername,
    listTrustedPeers,
    trustPeer,
    untrustPeer,
    setTrustedPeerRevoked,
    setProgress,
    getProgress,
    listBlobs() {
      return {
        private: privateBlobStore ? privateBlobStore.list() : [],
        public: publicBlobStore ? publicBlobStore.list() : [],
      };
    },
    publicProfileSnapshot() {
      if (!publicBlobStore || !record) return null;
      return {
        identityPublicKey: record.identityPublicKey,
        devicePublicKey: record.devicePublicKey,
        proof: record.proof,
        blobs: publicBlobStore.snapshot().blobs,
      };
    },
    verifyAttested,
    importProfile,
  };
}

module.exports = {
  createManager,
  RECORD_VERSION,
  ATTEST_SESSION_TTL_MS,
  toHex,
  fromHex,
};
