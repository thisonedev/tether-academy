const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const createTestnet = require('hyperdht/testnet.js');
const { createStore } = require('../electron/state-store.cjs');
const peer = require('../electron/peer.cjs');

function tmpStoreDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ta-peer-${label}-`));
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
  console.log('[test-peer] creating in-process hyperdht testnet (3 nodes)');
  const testnet = await createTestnet(3);
  const bootstrap = testnet.bootstrap;

  const hostDir = tmpStoreDir('host');
  const guestDir = tmpStoreDir('guest');
  const hostStore = await createStore(hostDir);
  const guestStore = await createStore(guestDir);
  console.log('[test-peer] host identity:', hostStore.identity.publicKey.slice(0, 16) + '...');
  console.log('[test-peer] guest identity:', guestStore.identity.publicKey.slice(0, 16) + '...');

  const host = require('../electron/peer.cjs');
  const guest = require('../electron/peer.cjs');

  delete require.cache[require.resolve('../electron/peer.cjs')];
  const freshHost = require('../electron/peer.cjs');
  delete require.cache[require.resolve('../electron/peer.cjs')];
  const freshGuest = require('../electron/peer.cjs');

  const hostPairedPromise = waitFor(freshHost, 'peer:paired');
  const guestPairedPromise = waitFor(freshGuest, 'peer:paired');

  await freshHost.init({ store: hostStore, bootstrap });
  await freshGuest.init({ store: guestStore, bootstrap });

  const invite = await freshHost.createInvite({ autoApprove: true });
  console.log('[test-peer] host created invite, session pub:', invite.sessionPublicKey.slice(0, 16) + '...');

  const acceptResult = await freshGuest.acceptInvite(invite.invite, {
    userData: { name: 'guest-from-test', hostname: os.hostname() },
  });
  console.log('[test-peer] guest accepted, paired with discovery:', acceptResult.discoveryKey.slice(0, 16) + '...');

  const [hostEvent, guestEvent] = await Promise.all([hostPairedPromise, guestPairedPromise]);

  if (hostEvent.discoveryKey !== guestEvent.discoveryKey) {
    console.error('[test-peer] FAIL: discovery key mismatch', { hostEvent, guestEvent });
    process.exit(1);
  }
  if (hostEvent.autobaseKey !== guestEvent.autobaseKey) {
    console.error('[test-peer] FAIL: autobaseKey mismatch', { hostEvent, guestEvent });
    process.exit(1);
  }
  if (hostEvent.role !== 'host' || guestEvent.role !== 'guest') {
    console.error('[test-peer] FAIL: role mismatch', { hostEvent: hostEvent.role, guestEvent: guestEvent.role });
    process.exit(1);
  }
  if (!hostEvent.userData || hostEvent.userData.name !== 'guest-from-test') {
    console.error('[test-peer] FAIL: host did not receive userData', hostEvent.userData);
    process.exit(1);
  }

  console.log('[test-peer] PASS: both sides paired, autobaseKey matched, userData delivered');
  console.log('[test-peer]   hostEvent.userData:', hostEvent.userData);
  console.log('[test-peer]   guestEvent.autobaseKey:', guestEvent.autobaseKey.slice(0, 16) + '...');

  const peersHost = freshHost.listPeers();
  const peersGuest = freshGuest.listPeers();
  if (peersHost.length !== 1 || peersGuest.length !== 1) {
    console.error('[test-peer] FAIL: listPeers wrong count', { peersHost, peersGuest });
    process.exit(1);
  }

  await freshHost.dropPeer(hostEvent.discoveryKey);
  await new Promise((r) => setTimeout(r, 100));
  if (freshHost.listPeers().length !== 0) {
    console.error('[test-peer] FAIL: dropPeer did not remove peer');
    process.exit(1);
  }
  console.log('[test-peer] PASS: dropPeer removed the pair');

  await freshHost.close();
  await freshGuest.close();
  await testnet.destroy();
  console.log('[test-peer] clean shutdown complete');
}

main().catch((err) => {
  console.error('[test-peer] ERR:', err);
  process.exit(1);
});
