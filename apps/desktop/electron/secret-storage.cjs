// Encrypt short secrets at rest. Prefers Electron safeStorage (OS keychain /
// DPAPI); outside Electron, falls back to AES-256-GCM with a per-userData key file.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { secretsDir } = require('../workers/sandbox/capabilities.cjs');

const LOCAL_KEY_FILE = 'identity-master.key';
const AES_ALGO = 'aes-256-gcm';

function tryLoadSafeStorage() {
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    const { safeStorage } = require('electron');
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function') {
      if (safeStorage.isEncryptionAvailable()) return safeStorage;
    }
  } catch {
    // not running under Electron
  }
  return null;
}

/**
 * Where this profile's fallback key lives: outside userData (the record it
 * decrypts sits there), named per profile so `--storage` instances differ.
 * @param {string} userDataDir
 * @param {string} [dir]
 * @returns {string}
 */
function localKeyPath(userDataDir, dir = secretsDir()) {
  const profile = crypto.createHash('sha256').update(path.resolve(userDataDir)).digest('hex').slice(0, 16);
  return path.join(dir, `identity-master-${profile}.key`);
}

function readKey(keyPath) {
  if (!fs.existsSync(keyPath)) return null;
  const key = fs.readFileSync(keyPath);
  return key.length === 32 ? key : null;
}

function ensureLocalKey(userDataDir, opts = {}) {
  const keyPath = localKeyPath(userDataDir, opts.keyDir || secretsDir(opts.homeDir || os.homedir()));
  const existing = readKey(keyPath);
  if (existing) return existing;

  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  // Migrate installs that predate the move; a fresh key would orphan everything sealed with the old one.
  const legacyPath = path.join(userDataDir, LOCAL_KEY_FILE);
  const legacy = readKey(legacyPath);
  const key = legacy ?? crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    // Windows may ignore mode
  }
  if (legacy) {
    try {
      fs.unlinkSync(legacyPath);
    } catch {
      // the copy is authoritative either way
    }
  }
  return key;
}

// Chromium tags a safeStorage payload with a version ('v10' basic, 'v11' OS
// keyring). A local AES payload opens with a random IV, so this only matches a
// record the keyring really sealed.
const SAFE_STORAGE_TAG = /^v1[01]$/;

/**
 * @param {string} payloadB64
 * @returns {boolean}
 */
function sealedBySafeStorage(payloadB64) {
  try {
    return SAFE_STORAGE_TAG.test(
      Buffer.from(payloadB64, 'base64').subarray(0, 3).toString('latin1'),
    );
  } catch {
    return false;
  }
}

function encryptAesGcm(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(AES_ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv | tag | ciphertext
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptAesGcm(payloadB64, key) {
  const buf = Buffer.from(payloadB64, 'base64');
  if (buf.length < 12 + 16 + 1) {
    throw new Error('secret-storage: ciphertext too short');
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv(AES_ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/**
 * @param {string} userDataDir
 * @param {{ safeStorage?: object | null, keyDir?: string }} [opts]
 *   safeStorage: null forces local AES. keyDir: overrides key location (tests).
 */
function createSecretStorage(userDataDir, opts = {}) {
  let safe =
    opts.safeStorage === undefined ? tryLoadSafeStorage() : opts.safeStorage;
  if (safe && typeof safe.isEncryptionAvailable === 'function' && !safe.isEncryptionAvailable()) {
    safe = null;
  }

  if (safe) {
    return {
      scheme: 'safeStorage',
      encryptString(plaintext) {
        const buf = safe.encryptString(plaintext);
        return Buffer.from(buf).toString('base64');
      },
      decryptString(payloadB64) {
        const buf = Buffer.from(payloadB64, 'base64');
        return safe.decryptString(buf);
      },
    };
  }

  const key = ensureLocalKey(userDataDir, opts);
  return {
    scheme: 'aes-gcm-local',
    encryptString(plaintext) {
      return encryptAesGcm(plaintext, key);
    },
    decryptString(payloadB64) {
      // The local key cannot open what the keyring sealed. Name that, rather
      // than surfacing the generic GCM authentication failure it becomes.
      if (sealedBySafeStorage(payloadB64)) {
        throw Object.assign(
          new Error(
            'Secrets on this device were sealed with the OS keyring, which is not '
            + 'available now. Unlock it (on Linux, the login keyring) and restart.',
          ),
          { code: 'ERR_KEYRING_UNAVAILABLE' },
        );
      }
      return decryptAesGcm(payloadB64, key);
    },
  };
}

function wipeStringRef(obj, key) {
  if (obj && typeof obj[key] === 'string') {
    // Best-effort: overwrite then delete (JS strings are immutable; clear ref).
    obj[key] = '';
    delete obj[key];
  }
}

module.exports = {
  createSecretStorage,
  tryLoadSafeStorage,
  sealedBySafeStorage,
  wipeStringRef,
  localKeyPath,
  LOCAL_KEY_FILE,
};
