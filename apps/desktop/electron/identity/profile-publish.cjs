'use strict';

// Public-profile mirror: wraps each attested blob in AES-256-GCM keyed by
// the identity's profileDiscoveryEncryptionKey (SLIP-21 from the root seed),
// so only a device holding the mnemonic can decrypt payloads, not any peer
// who merely knows the identity pubkey. On disk at profile-publish-v1.json;
// identityPublicKey, kind, and revision stay visible to anyone who reads the
// file, only the payload itself is encrypted.

const crypto = require('node:crypto');
const {
  BLOB_FILE_PUBLIC,
  canonicalBytes,
  attestPayload,
  verifyPayload,
  createStore,
} = require('./attested-blob-store.cjs');

const ALGO = 'aes-256-gcm';

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('hex'), ct: ct.toString('hex'), tag: tag.toString('hex') };
}

function decrypt(enc, key) {
  const iv = Buffer.from(enc.iv, 'hex');
  const ct = Buffer.from(enc.ct, 'hex');
  const tag = Buffer.from(enc.tag, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// profileDiscoveryKey is the 32-byte symmetric key from KeyChain.getSymmetricKey.
function createPublicStore({ filePath, profileDiscoveryKey, identityPublicKey }) {
  let data = { version: 1, identityPublicKey, blobs: {} };
  try {
    const fs = require('node:fs');
    if (fs.existsSync(filePath)) {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data.version !== 1) data = { version: 1, identityPublicKey, blobs: {} };
    }
  } catch {
    data = { version: 1, identityPublicKey, blobs: {} };
  }
  data.identityPublicKey = identityPublicKey;
  if (!data.blobs) data.blobs = {};

  function persist() {
    const fs = require('node:fs');
    const tmp = filePath + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch {}
  }

  function get(kind) {
    const entry = data.blobs[kind];
    if (!entry) return null;
    try {
      const payload = JSON.parse(decrypt(entry.payloadEnc, profileDiscoveryKey).toString('utf8'));
      return { kind: entry.kind, payload, proofB64: entry.proofB64, revision: entry.revision, updatedAt: entry.updatedAt };
    } catch {
      return null;
    }
  }

  function put(kind, { payload, proofB64, revision, updatedAt }) {
    const payloadEnc = encrypt(canonicalBytes(payload), profileDiscoveryKey);
    data.blobs[kind] = { kind, payloadEnc, proofB64, revision, updatedAt };
    persist();
    return data.blobs[kind];
  }

  function list() {
    return Object.entries(data.blobs).map(([kind, entry]) => ({
      kind,
      revision: entry.revision,
      updatedAt: entry.updatedAt,
    }));
  }

  function remove(kind) {
    if (!(kind in data.blobs)) return false;
    delete data.blobs[kind];
    persist();
    return true;
  }

  // Payloads stay encrypted here; only the identity's devices can decrypt them.
  function snapshot() {
    return {
      version: 1,
      identityPublicKey,
      blobs: data.blobs,
    };
  }

  return { get, put, list, remove, snapshot, filePath };
}

function publicStoreFromIdentity({ identity, userDataDir }) {
  const key = identity.getProfileDiscoveryEncryptionKey();
  if (!key || key.length !== 32) {
    throw new Error('profile-publish: invalid profile discovery key');
  }
  return createPublicStore({
    filePath: require('node:path').join(userDataDir, BLOB_FILE_PUBLIC),
    profileDiscoveryKey: key,
    identityPublicKey: Buffer.from(identity.identityPublicKey).toString('hex'),
  });
}

module.exports = {
  createPublicStore,
  publicStoreFromIdentity,
  encrypt,
  decrypt,
};