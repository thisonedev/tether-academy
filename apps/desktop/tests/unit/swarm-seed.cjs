'use strict';

// Pure HKDF derivation. The peer.cjs side of swarm seeding, that a live peer
// actually joins on the derived seed, is covered in integration/swarm-seed.cjs.

const test = require('brittle');
const crypto = require('node:crypto');
const DHT = require('hyperdht');

const {
  deriveSwarmSeed,
  deriveSwarmSeedHex,
  PEER_SWARM_INFO,
  QVAC_SWARM_INFO,
} = require('../../workers/peer/swarm-seed.cjs');

const privateKeyHex = () => crypto.randomBytes(32).toString('hex');

test('swarm-seed - derives a deterministic 32-byte seed', (t) => {
  const priv = privateKeyHex();
  const seed = deriveSwarmSeed(priv, PEER_SWARM_INFO);

  t.is(seed.length, 32);
  t.ok(deriveSwarmSeed(priv, PEER_SWARM_INFO).equals(seed), 'same input, same seed');
});

// The seed must come from private material. Deriving from the public key would
// let anyone who knows the public key compute the swarm identity.
test('swarm-seed - is not derivable from the public key', (t) => {
  const seed = deriveSwarmSeed(privateKeyHex(), PEER_SWARM_INFO);
  const publicAsSeed = Buffer.from(privateKeyHex(), 'hex');

  t.absent(seed.equals(publicAsSeed));
});

test('swarm-seed - mesh and QVAC use separate domains', (t) => {
  const priv = privateKeyHex();

  t.absent(
    deriveSwarmSeed(priv, PEER_SWARM_INFO).equals(deriveSwarmSeed(priv, QVAC_SWARM_INFO)),
    'same key, different info string, different seed',
  );
});

test('swarm-seed - hex variant matches the buffer variant', (t) => {
  const priv = privateKeyHex();
  const hex = deriveSwarmSeedHex(priv, PEER_SWARM_INFO);

  t.is(hex, deriveSwarmSeed(priv, PEER_SWARM_INFO).toString('hex'));
  t.is(hex.length, 64);
});

test('swarm-seed - rejects malformed key material', (t) => {
  t.exception(() => deriveSwarmSeed('not-hex'), /hex/);
  t.exception(() => deriveSwarmSeed('abcd'), /at least 32/);
  t.exception(() => deriveSwarmSeed(null), /hex/);
});

test('swarm-seed - yields a stable DHT keypair', (t) => {
  const seed = deriveSwarmSeed(privateKeyHex(), PEER_SWARM_INFO);

  t.ok(DHT.keyPair(seed).publicKey.equals(DHT.keyPair(seed).publicKey), 'deterministic');
  t.absent(
    DHT.keyPair(seed).publicKey.equals(DHT.keyPair(Buffer.from(privateKeyHex(), 'hex')).publicKey),
    'a different seed gives a different swarm identity',
  );
});
