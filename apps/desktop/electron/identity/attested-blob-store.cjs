'use strict';

// Attested blob store: JSON payloads bound to a Keet identity via
// IdentityKey.attestData. The private file is device-encrypted, local-only.
// The public file uses the seed-derived discovery key (only the mnemonic
// holder can decrypt it), for a future peer-publish channel.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const IdentityKey = require('keet-identity-key');

const BLOB_FILE_PRIVATE = 'attested-blobs-v1.json';
const BLOB_FILE_PUBLIC = 'profile-publish-v1.json';
const BLOB_VERSION = 1;

// Canonical JSON for hashing: sorts keys recursively (RFC 8785 / JCS
// equivalent) so payloads that differ only by key order hash the same.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

function canonicalBytes(value) {
  return Buffer.from(canonicalJson(value), 'utf8');
}

// sha256 stand-in for the proof's "data" field; keet-identity-key's hash()
// does its own internal hashing, so any 32-byte Buffer works here.
function payloadHash(payload) {
  return crypto.createHash('sha256').update(canonicalBytes(payload)).digest();
}

// Missing or empty file reads as a fresh store.
function readEnvelope(filePath, decrypt) {
  if (!fs.existsSync(filePath)) return null;
  const enc = fs.readFileSync(filePath);
  if (enc.length === 0) return null;
  let plain;
  try {
    plain = decrypt(enc);
  } catch (err) {
    throw new Error('blob store: failed to decrypt ' + filePath + ': ' + err.message);
  }
  try {
    return JSON.parse(plain.toString('utf8'));
  } catch {
    return null;
  }
}

function writeEnvelope(filePath, plaintextObj, encrypt) {
  const tmp = filePath + '.' + process.pid + '.tmp';
  const enc = encrypt(Buffer.from(JSON.stringify(plaintextObj), 'utf8'));
  fs.writeFileSync(tmp, enc);
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows may ignore
  }
}

function emptyStore(identityPublicKey) {
  return {
    version: BLOB_VERSION,
    identityPublicKey,
    blobs: {},
  };
}

function createStore({ filePath, encrypt, decrypt, identityPublicKey }) {
  let data = readEnvelope(filePath, decrypt) || emptyStore(identityPublicKey);
  if (data.identityPublicKey && data.identityPublicKey !== identityPublicKey) {
    // Cross-identity leak: refuse to read. The store is bound to a single
    // identity because the encryption key derives from the user's keychain.
    throw new Error('blob store: identity mismatch, refusing to read');
  }
  data.identityPublicKey = identityPublicKey;
  if (!data.blobs) data.blobs = {};

  function persist() {
    writeEnvelope(filePath, data, encrypt);
  }

  function get(kind) {
    return data.blobs[kind] || null;
  }

  // Caller builds the proof; put() just persists the resulting triple.
  function put(kind, entry) {
    data.blobs[kind] = entry;
    persist();
    return entry;
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

  function raw() {
    return data;
  }

  return { get, put, list, remove, raw, filePath };
}

function attestPayload({ kind, payload, deviceKeyPair, currentProofB64, identityKey }) {
  if (!kind || typeof kind !== 'string') {
    throw new Error('attest: kind must be a non-empty string');
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('attest: payload must be an object');
  }
  const wrapped = { kind, payload };
  const data = canonicalBytes(wrapped);
  const proof = currentProofB64 ? Buffer.from(currentProofB64, 'base64') : null;
  if (!proof) {
    // A null proof means we're being called outside the identity flow;
    // refuse rather than fall back to a device-rooted attestation, which
    // would break the chain.
    throw new Error('attest: missing identity proof chain');
  }
  const newProof = IdentityKey.attestData(data, deviceKeyPair, proof);
  return {
    kind,
    payload,
    proofB64: Buffer.from(newProof).toString('base64'),
    updatedAt: Date.now(),
  };
}

// Verifies a stored entry, unlike attestPayload which produces one.
function verifyPayload(entry, { IdentityKey, expectedIdentityPublicKeyHex }) {
  if (!entry || !entry.payload || !entry.proofB64) return false;
  const wrapped = { kind: entry.kind, payload: entry.payload };
  const data = canonicalBytes(wrapped);
  const proof = Buffer.from(entry.proofB64, 'base64');
  const opts = {};
  if (expectedIdentityPublicKeyHex) {
    opts.expectedIdentity = Buffer.from(expectedIdentityPublicKeyHex, 'hex');
  }
  const info = IdentityKey.verify(proof, data, opts);
  if (!info) return false;
  if (expectedIdentityPublicKeyHex) {
    const actual = Buffer.from(info.identityPublicKey).toString('hex');
    if (actual !== expectedIdentityPublicKeyHex) return false;
  }
  return true;
}

module.exports = {
  BLOB_FILE_PRIVATE,
  BLOB_FILE_PUBLIC,
  BLOB_VERSION,
  canonicalJson,
  canonicalBytes,
  payloadHash,
  createStore,
  attestPayload,
  verifyPayload,
  emptyStore,
};