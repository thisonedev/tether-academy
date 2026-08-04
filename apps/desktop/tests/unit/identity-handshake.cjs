'use strict';

// The crypto behind "this peer is who it says it is". Everything here is what a
// remote controls, so each field gets its own failing case.

const test = require('brittle');
const hypercoreCrypto = require('hypercore-crypto');
const IdentityKey = require('keet-identity-key');

const hs = require('../../workers/peer/identity-handshake.cjs');

const DISCOVERY_KEY = 'c'.repeat(64);
const OTHER_DISCOVERY_KEY = 'd'.repeat(64);

// A device key with the attestation chain binding it to a fresh root identity, as a real peer announces.
async function attestedDevice() {
  const mnemonic = IdentityKey.generateMnemonic();
  const id = await IdentityKey.from({ mnemonic });
  const device = hypercoreCrypto.keyPair();
  const proof = await id.bootstrap(device.publicKey);
  id.clear();
  return {
    device,
    devicePublicKey: device.publicKey.toString('hex'),
    identityPublicKey: Buffer.from(id.identityPublicKey).toString('hex'),
    proof: Buffer.from(proof).toString('base64'),
  };
}

test('identity-handshake - a signing keypair comes back from the device seed', (t) => {
  const kp = hypercoreCrypto.keyPair();
  const seed = kp.secretKey.subarray(0, 32).toString('hex');
  const derived = hs.deriveSigningKeyPair(seed);
  t.alike(derived.publicKey, kp.publicKey, 'the seed derives the same public key');
});

test('identity-handshake - a hello carries the announced keys and the proof', async (t) => {
  const peer = await attestedDevice();
  const nonce = hs.newNonce();
  const read = hs.readHello(
    hs.buildHello(nonce, {
      devicePublicKey: peer.devicePublicKey,
      identityPublicKey: peer.identityPublicKey,
      proof: peer.proof,
    }),
  );

  t.is(read.nonce, nonce);
  t.is(read.devicePublicKey, peer.devicePublicKey);
  t.is(read.identityPublicKey, peer.identityPublicKey);
  t.ok(read.identityProven, 'the chain binds that device key to that identity');
});

test('identity-handshake - a proof for one device does not cover another', async (t) => {
  const peer = await attestedDevice();
  const impostor = hypercoreCrypto.keyPair().publicKey.toString('hex');

  const read = hs.readHello(
    hs.buildHello(hs.newNonce(), {
      devicePublicKey: impostor,
      identityPublicKey: peer.identityPublicKey,
      proof: peer.proof,
    }),
  );
  t.absent(read.identityProven, 'announcing someone else’s proof proves nothing');
});

test('identity-handshake - claiming an identity the proof does not name fails', async (t) => {
  const peer = await attestedDevice();
  const other = await attestedDevice();

  const read = hs.readHello(
    hs.buildHello(hs.newNonce(), {
      devicePublicKey: peer.devicePublicKey,
      identityPublicKey: other.identityPublicKey,
      proof: peer.proof,
    }),
  );
  t.absent(read.identityProven);
});

test('identity-handshake - a hello with no proof is read but unproven', (t) => {
  const device = hypercoreCrypto.keyPair();
  const read = hs.readHello(
    hs.buildHello(hs.newNonce(), {
      devicePublicKey: device.publicKey.toString('hex'),
      identityPublicKey: null,
      proof: null,
    }),
  );
  t.ok(read, 'a peer without a root identity is still readable');
  t.is(read.identityPublicKey, null);
  t.absent(read.identityProven);
});

test('identity-handshake - malformed hellos are rejected outright', (t) => {
  const good = hs.buildHello(hs.newNonce(), { devicePublicKey: 'a'.repeat(64) });
  t.ok(hs.readHello(good));
  t.absent(hs.readHello(null));
  t.absent(hs.readHello({ ...good, devicePublicKey: 'nope' }), 'device key must be hex');
  t.absent(hs.readHello({ ...good, devicePublicKey: 'a'.repeat(62) }), 'and the right length');
  t.absent(hs.readHello({ ...good, nonce: 'short' }), 'nonce must be a full nonce');
});

test('identity-handshake - the reply proves the sender holds the announced key', (t) => {
  const kp = hypercoreCrypto.keyPair();
  const devicePublicKey = kp.publicKey.toString('hex');
  const nonce = hs.newNonce();

  const reply = hs.buildProofReply(DISCOVERY_KEY, nonce, kp);
  t.ok(
    hs.verifyProofReply(reply, { discoveryKeyHex: DISCOVERY_KEY, nonce, devicePublicKey }),
    'signed by the key it announced',
  );

  const impostor = hypercoreCrypto.keyPair().publicKey.toString('hex');
  t.absent(
    hs.verifyProofReply(reply, {
      discoveryKeyHex: DISCOVERY_KEY,
      nonce,
      devicePublicKey: impostor,
    }),
    'a different key does not verify',
  );
});

// A proof reply is public once sent, which is what the nonce is for.
test('identity-handshake - a reply cannot be replayed onto another challenge', (t) => {
  const kp = hypercoreCrypto.keyPair();
  const devicePublicKey = kp.publicKey.toString('hex');
  const nonce = hs.newNonce();
  const reply = hs.buildProofReply(DISCOVERY_KEY, nonce, kp);

  t.absent(
    hs.verifyProofReply(reply, {
      discoveryKeyHex: DISCOVERY_KEY,
      nonce: hs.newNonce(),
      devicePublicKey,
    }),
    'a fresh challenge is not answered by an old signature',
  );
  t.absent(
    hs.verifyProofReply({ ...reply, nonce: hs.newNonce() }, {
      discoveryKeyHex: DISCOVERY_KEY,
      nonce,
      devicePublicKey,
    }),
    'and relabelling the reply does not help',
  );
});

test('identity-handshake - a reply is bound to the pair it was made for', (t) => {
  const kp = hypercoreCrypto.keyPair();
  const nonce = hs.newNonce();
  const reply = hs.buildProofReply(DISCOVERY_KEY, nonce, kp);

  t.absent(
    hs.verifyProofReply(reply, {
      discoveryKeyHex: OTHER_DISCOVERY_KEY,
      nonce,
      devicePublicKey: kp.publicKey.toString('hex'),
    }),
    'the same nonce on another pair does not verify',
  );
});

test('identity-handshake - garbage signatures are rejected without throwing', (t) => {
  const devicePublicKey = hypercoreCrypto.keyPair().publicKey.toString('hex');
  const nonce = hs.newNonce();
  const opts = { discoveryKeyHex: DISCOVERY_KEY, nonce, devicePublicKey };

  t.absent(hs.verifyProofReply(null, opts));
  t.absent(hs.verifyProofReply({ nonce, signature: 42 }, opts), 'signature must be a string');
  t.absent(hs.verifyProofReply({ nonce, signature: 'not-base64!!' }, opts), 'wrong length');
  t.absent(
    hs.verifyProofReply({ nonce, signature: Buffer.alloc(64).toString('base64') }, opts),
    'a zeroed signature is still a bad signature',
  );
});

// Exec stdout runs through the same message slot, so the pre-check must be cheap and must not claim frames it cannot parse.
test('identity-handshake - frame detection ignores exec output', (t) => {
  const hello = Buffer.from(JSON.stringify(hs.buildHello(hs.newNonce(), { devicePublicKey: 'a'.repeat(64) })));
  t.ok(hs.isIdentityFrame(hello));
  t.absent(hs.isIdentityFrame(Buffer.from('plain stdout')));
  t.absent(hs.isIdentityFrame(Buffer.alloc(0)));
  t.absent(
    hs.isIdentityFrame(Buffer.concat([Buffer.alloc(64, 0x20), hello])),
    'the marker has to be at the head, not buried in a chunk',
  );
  t.absent(hs.isIdentityFrame(Buffer.alloc(9000)), 'and oversized buffers are not frames');
});
