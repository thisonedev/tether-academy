const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const createTestnet = require('hyperdht/testnet.js');
const { createStore } = require('../electron/state-store.cjs');

function tmpStoreDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ta-peer-wake-${label}-`));
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

async function measureOnce(label) {
  const { testnet, host, guest } = await makePeers(label);
  const hostPendingPromise = waitFor(host, 'peer:pending', null, 30_000);

  const invite = await host.createInvite();
  const acceptPromise = guest.acceptInvite(invite.invite, {
    userData: { name: 'guest-wake-test', hostname: os.hostname() },
    code: invite.pairingCode,
  });

  const pending = await hostPendingPromise;
  const guestPairedPromise = waitFor(guest, 'peer:paired', null, 30_000);

  const approveStart = Date.now();
  const approved = await host.approve(pending.requestId);
  if (!approved) {
    throw new Error('approve returned false');
  }
  const guestEvent = await guestPairedPromise;
  const guestPairedMs = Date.now() - approveStart;
  await acceptPromise;

  await cleanup(host, guest);
  await testnet.destroy();
  return { guestPairedMs, discoveryKey: guestEvent.discoveryKey };
}

async function main() {
  console.log('[pairing-wake] verifying wake mechanism reduces pair latency');
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const result = await measureOnce(`run-${i}`);
    runs.push(result.guestPairedMs);
    console.log(`[pairing-wake]   run ${i + 1}: guest paired in ${result.guestPairedMs}ms`);
  }
  const max = Math.max(...runs);
  const avg = Math.round(runs.reduce((a, b) => a + b, 0) / runs.length);
  console.log(`[pairing-wake] avg=${avg}ms, max=${max}ms`);

  if (max > 2000) {
    console.error(
      `[pairing-wake] FAIL: pairing took longer than 2s in at least one run. ` +
        `Without the wake, blind-pairing's 30s poll would dominate.`,
    );
    process.exit(1);
  }
  console.log('[pairing-wake] PASS: wake keeps guest pair under 2s across all runs');
}

main().catch((err) => {
  console.error('[pairing-wake] ERR:', err);
  process.exit(1);
});
