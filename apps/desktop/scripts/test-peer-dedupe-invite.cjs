// Single guest accepting the same invite twice should surface only one
// pending request on the host. The two candidates have different discovery
// keys (different sessions) but the same invite ID.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const createTestnet = require('hyperdht/testnet.js');
const { createStore } = require('../electron/state-store.cjs');

function tmpStoreDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ta-peer-dedupe-invite-${label}-`));
}

async function main() {
  console.log('[test-peer-dedupe-invite] creating in-process hyperdht testnet');
  const testnet = await createTestnet(3);
  const bootstrap = testnet.bootstrap;

  const hostDir = tmpStoreDir('host');
  const hostStore = await createStore(hostDir);
  const guestDir = tmpStoreDir('guest');
  const guestStore = await createStore(guestDir);

  delete require.cache[require.resolve('../electron/peer.cjs')];
  const host = require('../electron/peer.cjs');
  await host.init({ store: hostStore, bootstrap });

  delete require.cache[require.resolve('../electron/peer.cjs')];
  const guest = require('../electron/peer.cjs');
  await guest.init({ store: guestStore, bootstrap });

  const invite = await host.createInvite();
  console.log('[test-peer-dedupe-invite] invite code:', invite.pairingCode);

  // First accept from the same guest store.
  guest.acceptInvite(invite.invite, {
    userData: { name: 'same-guest', source: 'invite-dedupe-test' },
    code: invite.pairingCode,
  }).catch(() => {});

  // Wait for the first candidate to land.
  await new Promise((r) => setTimeout(r, 2000));

  let pending = host.listPending();
  console.log('[test-peer-dedupe-invite] pending after first accept:', pending.length);
  if (pending.length !== 1) {
    console.error('[test-peer-dedupe-invite] FAIL: expected 1 after first accept, got', pending.length);
    process.exit(1);
  }

  // Second accept from the same guest (new session, same invite ID).
  guest.acceptInvite(invite.invite, {
    userData: { name: 'same-guest', source: 'invite-dedupe-test' },
    code: invite.pairingCode,
  }).catch(() => {});

  await new Promise((r) => setTimeout(r, 1500));

  pending = host.listPending();
  console.log('[test-peer-dedupe-invite] pending after second accept:', pending.length);
  if (pending.length !== 1) {
    console.error('[test-peer-dedupe-invite] FAIL: expected 1 after second accept, got', pending.length);
    process.exit(1);
  }
  console.log('[test-peer-dedupe-invite] PASS: same invite rejected the second candidate');

  await guest.close().catch(() => {});
  await host.close();
  await testnet.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error('[test-peer-dedupe-invite] ERR:', err);
  process.exit(1);
});
