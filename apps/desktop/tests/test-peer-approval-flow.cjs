const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const createTestnet = require('hyperdht/testnet.js');
const { createStore } = require('../electron/state-store.cjs');

function tmpStoreDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ta-peer-approval-${label}-`));
}

function waitFor(emitter, eventName, predicate, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${eventName} after ${timeoutMs}ms`));
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

function freshRequire(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

async function makePeers(label) {
  const testnet = await createTestnet(3);
  const hostStore = await createStore(tmpStoreDir(`host-${label}`));
  const guestStore = await createStore(tmpStoreDir(`guest-${label}`));
  const host = freshRequire('../electron/peer.cjs');
  const guest = freshRequire('../electron/peer.cjs');
  await host.init({ store: hostStore, bootstrap: testnet.bootstrap });
  await guest.init({ store: guestStore, bootstrap: testnet.bootstrap });
  return { testnet, host, guest, hostStore, guestStore };
}

async function cleanup(host, guest) {
  await Promise.all(
    [host, guest].map((p) =>
      Promise.race([p.close(), new Promise((r) => setTimeout(r, 2000))]).catch(() => {}),
    ),
  );
}

async function main() {
  console.log('[approval-flow] creating in-process hyperdht testnet (3 nodes)');
  const { testnet, host, guest, hostStore, guestStore } = await makePeers('manual');

  console.log('[approval-flow] host identity:', hostStore.identity.publicKey.slice(0, 16) + '...');
  console.log('[approval-flow] guest identity:', guestStore.identity.publicKey.slice(0, 16) + '...');

  // 30s budget: DHT roundtrip + approve() can take a few seconds.
  const hostPendingPromise = waitFor(host, 'peer:pending', null, 30_000);

  console.log('[approval-flow] host creates invite (manual approval)');
  const invite = await host.createInvite();
  console.log('[approval-flow]   pairing code:', invite.pairingCode);

  console.log('[approval-flow] guest accepts invite');
  const acceptPromise = guest.acceptInvite(invite.invite, {
    userData: { name: 'guest-needs-approval', hostname: os.hostname() },
    code: invite.pairingCode,
  });

  console.log('[approval-flow] waiting for host to see pending request');
  const pending = await hostPendingPromise;
  console.log('[approval-flow]   host got pending:', pending.requestId.slice(0, 8));

  // Register paired listeners just before approve so the 30s window starts when the test is actually waiting.
  const hostPairedPromise = waitFor(host, 'peer:paired', null, 30_000);
  const guestPairedPromise = waitFor(guest, 'peer:paired', null, 30_000);

  console.log('[approval-flow] host approves');
  const approved = await host.approve(pending.requestId);
  if (!approved) {
    console.error('[approval-flow] FAIL: approve returned false');
    process.exit(1);
  }
  console.log('[approval-flow] approve returned true');

  console.log('[approval-flow] waiting for host peer:paired...');
  const hostEvent = await hostPairedPromise;
  console.log('[approval-flow]   host paired:', hostEvent.discoveryKey.slice(0, 16) + '...');

  console.log('[approval-flow] waiting for GUEST peer:paired (this is the bug check)...');
  const guestEvent = await guestPairedPromise;
  console.log('[approval-flow]   guest paired:', guestEvent.discoveryKey.slice(0, 16) + '...');

  if (hostEvent.discoveryKey !== guestEvent.discoveryKey) {
    console.error('[approval-flow] FAIL: discovery key mismatch', {
      host: hostEvent.discoveryKey,
      guest: guestEvent.discoveryKey,
    });
    process.exit(1);
  }
  if (hostEvent.autobaseKey !== guestEvent.autobaseKey) {
    console.error('[approval-flow] FAIL: autobaseKey mismatch', {
      host: hostEvent.autobaseKey,
      guest: guestEvent.autobaseKey,
    });
    process.exit(1);
  }
  if (hostEvent.role !== 'host' || guestEvent.role !== 'guest') {
    console.error('[approval-flow] FAIL: role mismatch', {
      host: hostEvent.role,
      guest: guestEvent.role,
    });
    process.exit(1);
  }

  await acceptPromise;
  console.log('[approval-flow] PASS: manual approval - both sides paired, autobaseKey matched');

  const auditTypes = host.getAudit().map((e) => e.type);
  const expected = ['peer:pending', 'peer:approved', 'peer:paired'];
  for (const t of expected) {
    if (!auditTypes.includes(t)) {
      console.error('[approval-flow] FAIL: host audit missing', t, auditTypes);
      process.exit(1);
    }
  }
  console.log('[approval-flow] PASS: audit trail includes pending + approved + paired');

  await cleanup(host, guest);
  await testnet.destroy();
  console.log('[approval-flow] clean shutdown complete');
}

main().catch((err) => {
  console.error('[approval-flow] ERR:', err);
  process.exit(1);
});
