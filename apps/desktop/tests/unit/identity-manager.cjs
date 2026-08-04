'use strict';

// Root + device identity via keet-identity-key: create, back up, recover.
// safeStorage is null throughout so these run headless; the OS keychain path is exercised by the app, not here.

const test = require('brittle');

const { createManager } = require('../../electron/identity/manager.cjs');
const { tmpDir } = require('../helpers/index.cjs');

const manager = (t, label) => createManager(tmpDir(t, `idm-${label}`), { safeStorage: null });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('identity-manager - starts with no identity', (t) => {
  t.is(manager(t, 'empty').status(), 'none');
});

// A new identity is not usable until the user confirms they wrote the mnemonic down, since losing it means losing the root key.
test('identity-manager - createNew withholds ready until backup is confirmed', async (t) => {
  const m = manager(t, 'create');

  const created = await m.createNew();
  t.ok(created.mnemonic.split(' ').length >= 12, 'mnemonic is at least 12 words');
  t.ok(created.identityPublicKey);
  t.ok(created.devicePublicKey);
  t.is(m.status(), 'pending-backup');

  m.confirmBackup();
  t.is(m.status(), 'ready');
});

test('identity-manager - publicView describes a ready identity', async (t) => {
  const m = manager(t, 'view');
  await m.createNew();
  m.confirmBackup();

  const view = m.publicView();
  t.is(view.source, 'tether-academy');
  t.is(view.ready, true);
  t.ok(view.holdsRoot, 'this device holds the root key');
});

test('identity-manager - device identity matches the public view', async (t) => {
  const m = manager(t, 'device');
  await m.createNew();
  m.confirmBackup();

  const view = m.publicView();
  const device = m.getDeviceIdentity();

  t.ok(device.privateKey, 'device private key available in-process');
  t.is(device.publicKey, view.devicePublicKey);
  t.is(device.identityPublicKey, view.identityPublicKey);
});

test('identity-manager - attestation is what a peer needs to check the binding', async (t) => {
  const m = manager(t, 'attest');
  t.is(m.attestation(), null, 'nothing to announce before onboarding');

  await m.createNew();
  t.is(m.attestation(), null, 'nor while the backup is unconfirmed');

  m.confirmBackup();
  const view = m.publicView();
  const announced = m.attestation();
  t.is(announced.devicePublicKey, view.devicePublicKey);
  t.is(announced.identityPublicKey, view.identityPublicKey);
  t.ok(announced.proof, 'and the chain that ties them together');
});

test('identity-manager - revokedDeviceKeys lists only revoked devices', async (t) => {
  const m = manager(t, 'revoked');
  await m.createNew();
  m.confirmBackup();
  t.alike(m.revokedDeviceKeys(), [], 'the device that created the identity is not revoked');

  const other = 'b'.repeat(64);
  m.revokeDevice(other);
  t.alike(m.revokedDeviceKeys(), [other]);
});

// The device-link flow was removed rather than patched: it never validated a returned proof against the challenge it issued.
test('identity-manager - the unbound device-link flow is gone', (t) => {
  const m = createManager(tmpDir(t, 'idm-no-link'), { safeStorage: null });

  t.is(m.beginLinkRequest, undefined, 'no challenge is minted');
  t.is(m.completeLinkWithProof, undefined, 'and no proof can be handed back');
  t.is(m.status(), 'none', 'with no pending-link state to sit in');
});

// One leg of a flow happening at two devices at once; left open, it would stay confirmable indefinitely.
test('identity-manager - an attest session stops being confirmable once it expires', async (t) => {
  const m = createManager(tmpDir(t, 'idm-attest-ttl'), {
    safeStorage: null,
    attestSessionTtlMs: 1,
  });
  await m.createNew();
  m.confirmBackup();

  const { sessionId } = m.beginAttestSession('b'.repeat(64));
  await sleep(5);
  await t.exception(m.finishAttest(sessionId, { confirm: true }), /expired/);
  t.is(m.listAttestSessions().length, 0, 'and it is gone from the list');
});

test('identity-manager - recovers the same root from a mnemonic', async (t) => {
  const original = manager(t, 'origin');
  const { mnemonic } = await original.createNew();
  original.confirmBackup();
  const rootKey = original.publicView().identityPublicKey;

  const recovered = await manager(t, 'recover').recoverFromMnemonic(mnemonic);

  t.is(recovered.identityPublicKey, rootKey);
  t.is(recovered.ready, true, 'recovery implies the mnemonic is already backed up');
});
