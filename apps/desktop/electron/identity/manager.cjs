// Root + device identity (keet-identity-key).
// Sources: 'tether-academy' (default) | 'keet-linked' (QR/attest only).
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

const RECORD_FILE = 'identity-v3.json';
const RECORD_VERSION = 3;
// An attest session is one leg of a hands-on flow happening at two devices at
// once. Nothing about it should stay confirmable overnight, so it ages out
// instead of waiting for a caller that never returns.
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

  function init() {
    record = loadRecordFromDisk();
    if (record) hydrateSecrets();
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
    // TA root identities require backup confirmation before mesh use.
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
    // Refuse if revoked.
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
      // If this is the first extra device, attest from current device chain.
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
    try {
      if (fs.existsSync(recordPath)) fs.unlinkSync(recordPath);
    } catch {
      // ignore
    }
    return { status: 'none' };
  }

  function peekPendingMnemonic() {
    // Only available between createNew and confirmBackup.
    return pendingMnemonic;
  }

  init();

  return {
    status,
    publicView,
    /** 'safeStorage' or 'aes-gcm-local'. Peer-exec refuses the latter. */
    secretScheme: () => secrets.scheme,
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
  };
}

module.exports = {
  createManager,
  RECORD_VERSION,
  ATTEST_SESSION_TTL_MS,
  toHex,
  fromHex,
};
