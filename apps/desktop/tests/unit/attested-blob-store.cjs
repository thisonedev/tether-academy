'use strict';

const test = require('brittle');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  canonicalJson,
  canonicalBytes,
  createStore,
  attestPayload,
  verifyPayload,
  emptyStore,
  BLOB_FILE_PRIVATE,
  BLOB_FILE_PUBLIC,
} = require('../../electron/identity/attested-blob-store.cjs');
const { createPublicStore, publicStoreFromIdentity } = require('../../electron/identity/profile-publish.cjs');
const IdentityKey = require('keet-identity-key');
const hypercoreCrypto = require('hypercore-crypto');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'academy-blob-test-'));
}

// Test encryption scheme: AES-GCM with a fixed key. Same surface as
// secret-storage's encryptString / decryptString but deterministic for tests.
function makeTestSecrets() {
  const key = crypto.randomBytes(32);
  function encrypt(plaintext) {
    const buf = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]);
  }
  function decrypt(enc) {
    const iv = enc.subarray(0, 12);
    const tag = enc.subarray(12, 28);
    const ct = enc.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }
  return { encrypt, decrypt };
}

function makeDeviceKeyPair() {
  return hypercoreCrypto.keyPair();
}

async function makeIdentity() {
  const mnemonic = IdentityKey.generateMnemonic();
  const id = await IdentityKey.from({ mnemonic });
  return { id, mnemonic };
}

test('canonicalJson sorts object keys deterministically', (t) => {
  const a = canonicalJson({ b: 1, a: 2, c: { y: 1, x: 2 } });
  const b = canonicalJson({ c: { x: 2, y: 1 }, a: 2, b: 1 });
  t.is(a, b);
  t.is(a, '{"a":2,"b":1,"c":{"x":2,"y":1}}');
});

test('canonicalBytes - arrays preserve order', (t) => {
  const a = canonicalBytes([1, 2, 3]);
  const b = canonicalBytes([1, 2, 3]);
  t.alike(a, b);
  const c = canonicalBytes([3, 2, 1]);
  t.unlike(a.toString(), c.toString());
});

test('createStore - empty store round-trips', (t) => {
  const dir = tmpdir();
  try {
    const filePath = path.join(dir, BLOB_FILE_PRIVATE);
    const { encrypt, decrypt } = makeTestSecrets();
    const store = createStore({
      filePath,
      encrypt: (buf) => encrypt(buf),
      decrypt: (buf) => decrypt(buf),
      identityPublicKey: 'aa'.repeat(32),
    });
    t.is(store.get('username'), null);
    t.alike(store.list(), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createStore - put then get round-trips through encryption', (t) => {
  const dir = tmpdir();
  try {
    const filePath = path.join(dir, BLOB_FILE_PRIVATE);
    const { encrypt, decrypt } = makeTestSecrets();
    const store = createStore({
      filePath,
      encrypt: (buf) => encrypt(buf),
      decrypt: (buf) => decrypt(buf),
      identityPublicKey: 'aa'.repeat(32),
    });
    store.put('progress', {
      kind: 'progress',
      payload: { lessons: { 'getting-started': 'done' } },
      proofB64: 'abc',
      revision: 1,
      updatedAt: 1700000000,
    });
    const got = store.get('progress');
    t.ok(got);
    t.is(got.kind, 'progress');
    t.alike(got.payload, { lessons: { 'getting-started': 'done' } });
    t.is(got.proofB64, 'abc');

    // Re-open and verify the file was actually encrypted on disk
    const onDisk = fs.readFileSync(filePath);
    t.ok(onDisk.length > 0);
    const plain = JSON.parse(decrypt(onDisk).toString('utf8'));
    t.alike(plain.blobs.progress.payload, { lessons: { 'getting-started': 'done' } });

    const store2 = createStore({
      filePath,
      encrypt: (buf) => encrypt(buf),
      decrypt: (buf) => decrypt(buf),
      identityPublicKey: 'aa'.repeat(32),
    });
    const reGot = store2.get('progress');
    t.ok(reGot);
    t.is(reGot.kind, 'progress');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createStore - identity mismatch refuses to read', (t) => {
  const dir = tmpdir();
  try {
    const filePath = path.join(dir, BLOB_FILE_PRIVATE);
    const { encrypt, decrypt } = makeTestSecrets();
    const store = createStore({
      filePath,
      encrypt: (buf) => encrypt(buf),
      decrypt: (buf) => decrypt(buf),
      identityPublicKey: 'aa'.repeat(32),
    });
    store.put('x', { kind: 'x', payload: { v: 1 }, proofB64: 'p', revision: 1, updatedAt: 0 });
    // Re-open with a different identity
    t.exception(() => {
      createStore({
        filePath,
        encrypt: (buf) => encrypt(buf),
        decrypt: (buf) => decrypt(buf),
        identityPublicKey: 'bb'.repeat(32),
      });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('attestPayload - real Keet identity proof verifies', async (t) => {
  const { id, mnemonic } = await makeIdentity();
  const device = makeDeviceKeyPair();
  const proof1 = await IdentityKey.bootstrap({ mnemonic }, device.publicKey);
  const entry = attestPayload({
    kind: 'username',
    payload: { username: 'dee' },
    deviceKeyPair: device,
    currentProofB64: Buffer.from(proof1).toString('base64'),
    identityKey: id,
  });
  t.ok(entry);
  t.is(entry.kind, 'username');
  t.is(entry.payload.username, 'dee');
  t.ok(entry.proofB64);
  // Verify the proof with the SDK
  const wrapped = canonicalBytes({ kind: 'username', payload: entry.payload });
  const verified = IdentityKey.verify(Buffer.from(entry.proofB64, 'base64'), wrapped, {
    expectedIdentity: id.identityPublicKey,
  });
  t.ok(verified, 'SDK verifies the attested blob');
  t.alike(verified.identityPublicKey, id.identityPublicKey);
  t.alike(verified.devicePublicKey, device.publicKey);
  id.clear();
});

test('verifyPayload - returns false for tampered payload', async (t) => {
  const { id, mnemonic } = await makeIdentity();
  const device = makeDeviceKeyPair();
  const proof1 = await IdentityKey.bootstrap({ mnemonic }, device.publicKey);
  const entry = attestPayload({
    kind: 'username',
    payload: { username: 'dee' },
    deviceKeyPair: device,
    currentProofB64: Buffer.from(proof1).toString('base64'),
    identityKey: id,
  });
  // Tamper with the payload
  const tampered = { kind: 'username', payload: { username: 'mallory' }, proofB64: entry.proofB64, revision: 1, updatedAt: entry.updatedAt };
  t.is(
    verifyPayload(tampered, {
      IdentityKey,
      expectedIdentityPublicKeyHex: Buffer.from(id.identityPublicKey).toString('hex'),
    }),
    false,
    'tampered payload should fail verification',
  );
  id.clear();
});

test('verifyPayload - wrong identity fails', async (t) => {
  const idA = await IdentityKey.from({ mnemonic: IdentityKey.generateMnemonic() });
  const idB = await IdentityKey.from({ mnemonic: IdentityKey.generateMnemonic() });
  const device = makeDeviceKeyPair();
  const proofA = await idA.bootstrap(device.publicKey);
  const entry = attestPayload({
    kind: 'username',
    payload: { username: 'dee' },
    deviceKeyPair: device,
    currentProofB64: Buffer.from(proofA).toString('base64'),
    identityKey: idA,
  });
  t.is(
    verifyPayload(entry, {
      IdentityKey,
      expectedIdentityPublicKeyHex: Buffer.from(idB.identityPublicKey).toString('hex'),
    }),
    false,
  );
  idA.clear();
  idB.clear();
});

test('public store - encrypted blobs decrypt and verify', async (t) => {
  const dir = tmpdir();
  try {
    const { id, mnemonic } = await makeIdentity();
    const filePath = path.join(dir, BLOB_FILE_PUBLIC);
    const identityPublicKeyHex = Buffer.from(id.identityPublicKey).toString('hex');
    const store = publicStoreFromIdentity({
      identity: id,
      userDataDir: dir,
    });
    const device = makeDeviceKeyPair();
    const proof1 = await IdentityKey.bootstrap({ mnemonic }, device.publicKey);
    const entry = attestPayload({
      kind: 'username',
      payload: { username: 'dee' },
      deviceKeyPair: device,
      currentProofB64: Buffer.from(proof1).toString('base64'),
      identityKey: id,
    });
    store.put('username', {
      payload: entry.payload,
      proofB64: entry.proofB64,
      revision: 1,
      updatedAt: entry.updatedAt,
    });
    // Re-open with a fresh identity derived from the same mnemonic:
    // profile discovery key is shared, so encryption round-trips.
    const id2 = await IdentityKey.from({ mnemonic });
    const store2 = publicStoreFromIdentity({ identity: id2, userDataDir: dir });
    const got = store2.get('username');
    t.ok(got);
    t.is(got.payload.username, 'dee');
    t.is(got.proofB64, entry.proofB64);
    // Verify signature still holds
    const wrapped = canonicalBytes({ kind: 'username', payload: got.payload });
    const verified = IdentityKey.verify(Buffer.from(got.proofB64, 'base64'), wrapped, {
      expectedIdentity: id.identityPublicKey,
    });
    t.ok(verified);
    id.clear();
    id2.clear();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('emptyStore is shaped correctly', (t) => {
  const e = emptyStore('aa'.repeat(32));
  t.is(e.version, 1);
  t.is(e.identityPublicKey, 'aa'.repeat(32));
  t.alike(e.blobs, {});
});

test('createStore - list returns revisions and timestamps', (t) => {
  const dir = tmpdir();
  try {
    const filePath = path.join(dir, BLOB_FILE_PRIVATE);
    const { encrypt, decrypt } = makeTestSecrets();
    const store = createStore({
      filePath,
      encrypt: (buf) => encrypt(buf),
      decrypt: (buf) => decrypt(buf),
      identityPublicKey: 'aa'.repeat(32),
    });
    store.put('a', { kind: 'a', payload: {}, proofB64: '', revision: 1, updatedAt: 100 });
    store.put('b', { kind: 'b', payload: {}, proofB64: '', revision: 2, updatedAt: 200 });
    const list = store.list();
    t.is(list.length, 2);
    const seen = Object.fromEntries(list.map((e) => [e.kind, e]));
    t.is(seen.a.revision, 1);
    t.is(seen.b.revision, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});