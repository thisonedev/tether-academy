'use strict';

// The pear-end facade is what main.js talks to; it never requires peer.cjs
// directly. This covers the sequencing main.js depends on (identity before peer init) and that calls reach the real peer, not a local stub.

const test = require('brittle');

const { createPearEnd } = require('../../electron/pear-end/index.cjs');
const { createTestnetFor, tmpDir } = require('../helpers/index.cjs');

async function createFacade(t, label) {
  const testnet = await createTestnetFor(t);
  const pearEnd = createPearEnd(tmpDir(t, `pearend-${label}`), { getSafeStorage: () => null });
  // shutdown() is idempotent, so registering it unconditionally is safe even for the test that shuts down explicitly.
  t.teardown(() => pearEnd.shutdown(), { order: 1 });
  return { pearEnd, testnet };
}

test('pear-end - starts with no identity', async (t) => {
  const { pearEnd } = await createFacade(t, 'empty');
  t.is(pearEnd.identity().status(), 'none');
});

test('pear-end - ensureReady initialises the worker peer with the device identity', async (t) => {
  const { pearEnd, testnet } = await createFacade(t, 'ready');

  const created = await pearEnd.identity().createNew();
  pearEnd.identity().confirmBackup();
  t.is(pearEnd.identity().status(), 'ready');

  t.is(await pearEnd.ensureReady({ bootstrap: testnet.bootstrap }), true);

  // getIdentity() is async here: an RPC round-trip to the worker, unlike the synchronous in-process call peer.cjs exposes.
  const meshIdentity = await pearEnd.peer.getIdentity();
  t.ok(meshIdentity, 'peer.init ran through the facade');
  t.is(meshIdentity.publicKey, created.devicePublicKey, 'worker got the real device identity');
});

test('pear-end - peer calls pass through to the worker', async (t) => {
  const { pearEnd, testnet } = await createFacade(t, 'passthrough');

  await pearEnd.identity().createNew();
  pearEnd.identity().confirmBackup();
  await pearEnd.ensureReady({ bootstrap: testnet.bootstrap });

  const invite = await pearEnd.peer.createInvite({ autoApprove: true });
  t.ok(invite.pairingCode);
  t.ok(invite.invite);
});

// main.js calls shutdown() on both window-close and app-quit, so a second call must not throw.
test('pear-end - shutdown is idempotent', async (t) => {
  const { pearEnd, testnet } = await createFacade(t, 'shutdown');

  await pearEnd.identity().createNew();
  pearEnd.identity().confirmBackup();
  await pearEnd.ensureReady({ bootstrap: testnet.bootstrap });

  await t.execution(pearEnd.shutdown(), 'first shutdown');
  await t.execution(pearEnd.shutdown(), 'second shutdown does not throw');
});

// Proving a device key is what earns an entry; claiming one earns nothing.
test('pear-end - a verified peer is recorded, an unverified one is not', async (t) => {
  const { pearEnd } = await createFacade(t, 'trusted');
  await pearEnd.identity().createNew();
  pearEnd.identity().confirmBackup();

  const DEVICE = 'a'.repeat(64);
  const IDENTITY = 'b'.repeat(64);

  await pearEnd._rememberVerifiedPeer({
    discoveryKey: 'f'.repeat(64),
    identityVerified: false,
    verifiedDevicePublicKey: DEVICE,
  });
  t.alike(pearEnd.identity().listTrustedPeers(), [], 'a peer that proved nothing is not recorded');

  await pearEnd._rememberVerifiedPeer({
    discoveryKey: 'f'.repeat(64),
    identityVerified: true,
    verifiedDevicePublicKey: DEVICE,
    verifiedIdentityPublicKey: IDENTITY,
  });

  const trusted = pearEnd.identity().listTrustedPeers();
  t.is(trusted.length, 1, 'a verified peer is remembered');
  t.is(trusted[0].devicePublicKey, DEVICE, 'keyed by the key it proved');
  t.is(trusted[0].identityPublicKey, IDENTITY);
  t.is(trusted[0].revoked, false);
});
