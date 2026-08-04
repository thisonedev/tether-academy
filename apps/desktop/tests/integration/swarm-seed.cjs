'use strict';

// A live peer must seed its swarm from private key material; seeding from the
// public key would let anyone holding it sit on the same topic. The derivation
// itself is unit/swarm-seed.cjs. This is the part needing a real peer: that
// peer.cjs uses it and records so in the audit log.

const test = require('brittle');
const Hyperswarm = require('hyperswarm');

const { createPeers } = require('../helpers/index.cjs');
const { deriveSwarmSeed, PEER_SWARM_INFO } = require('../../workers/peer/swarm-seed.cjs');

test('swarm-seed - a live peer derives its swarm identity from private material', async (t) => {
  const { peers: [peer], identities: [device], testnet } = await createPeers(t, 1, { label: 'seed' });

  const expected = new Hyperswarm({
    seed: deriveSwarmSeed(device.privateKey, PEER_SWARM_INFO),
    bootstrap: testnet.bootstrap,
  });
  t.teardown(() => expected.destroy(), { order: 1 });
  await expected.dht.fullyBootstrapped();

  const fromPublicKey = new Hyperswarm({
    seed: Buffer.from(device.publicKey, 'hex'),
    bootstrap: testnet.bootstrap,
  });
  t.teardown(() => fromPublicKey.destroy(), { order: 1 });
  await fromPublicKey.dht.fullyBootstrapped();

  t.absent(
    expected.keyPair.publicKey.equals(fromPublicKey.keyPair.publicKey),
    'the public key is not the seed',
  );

  const seedEvent = peer.getAudit().find((e) => e.type === 'peer:swarm-seed');
  t.ok(seedEvent, 'peer records how it seeded the swarm');
  t.is(seedEvent.scheme, 'hkdf-sha256-v1', 'and names the derivation scheme');
});
