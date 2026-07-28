// Stress test: a single member receiving many parallel candidates should
// only ever surface one pending request at a time.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const createTestnet = require('hyperdht/testnet.js');
const { createStore } = require('../electron/state-store.cjs');

function tmpStoreDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ta-peer-dedupe-${label}-`));
}

function waitFor(emitter, eventName, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${eventName}`));
    }, timeoutMs);
    function onEvent(event, payload) {
      if (event !== eventName) return;
      if (predicate && !predicate(payload)) return;
      off();
      clearTimeout(timer);
      resolve(payload);
    }
    const off = emitter.on(onEvent);
  });
}

async function main() {
  console.log('[test-peer-dedupe] creating in-process hyperdht testnet');
  const testnet = await createTestnet(3);
  const bootstrap = testnet.bootstrap;

  const hostDir = tmpStoreDir('host');
  const hostStore = await createStore(hostDir);

  delete require.cache[require.resolve('../electron/peer.cjs')];
  const host = require('../electron/peer.cjs');

  await host.init({ store: hostStore, bootstrap });
  console.log('[test-peer-dedupe] host pubkey:', hostStore.identity.publicKey.slice(0, 16) + '...');

  // Create one invite.
  const invite = await host.createInvite();
  console.log('[test-peer-dedupe] invite code:', invite.pairingCode);

  // Race 5 parallel guests at the same member.
  const guestCount = 5;
  const guests = [];
  for (let i = 0; i < guestCount; i++) {
    delete require.cache[require.resolve('../electron/peer.cjs')];
    const guest = require('../electron/peer.cjs');
    const guestStore = await createStore(tmpStoreDir(`guest${i}`));
    await guest.init({ store: guestStore, bootstrap });
    guest.acceptInvite(invite.invite, {
      userData: { name: `guest${i}`, source: 'dedupe-test' },
      code: invite.pairingCode,
    }).catch(() => {});
    guests.push(guest);
  }

  // Give onadd time to fire.
  await new Promise((r) => setTimeout(r, 1500));

  const pending = host.listPending();
  console.log('[test-peer-dedupe] pending count:', pending.length);
  if (pending.length !== 1) {
    console.error('[test-peer-dedupe] FAIL: expected exactly 1 pending, got', pending.length);
    process.exit(1);
  }
  console.log('[test-peer-dedupe] PASS: dedupe held under 5 parallel candidates');

  for (const g of guests) await g.close().catch(() => {});
  await host.close();
  await testnet.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error('[test-peer-dedupe] ERR:', err);
  process.exit(1);
});
