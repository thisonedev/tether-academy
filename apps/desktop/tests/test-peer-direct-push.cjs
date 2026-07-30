// Regression test for the pairing hang: when the DHT put fails (or is slow,
// or returns a stale value from a prior attempt) the guest must still pair
// because the response is pushed directly to it over the exec protomux
// channel, not via the DHT poll cycle.
//
// We simulate the production failure by sabotaging both the DHT put and the
// blind-pairing direct channel send. Only the exec-channel push can pair the
// guest. If the test times out, the fix is missing.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const createTestnet = require('hyperdht/testnet.js');
const { createStore } = require('../electron/state-store.cjs');

function tmpStoreDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ta-peer-directpush-${label}-`));
}

function waitFor(emitter, eventName, predicate, timeoutMs = 5000) {
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

async function runScenario({ label, sabotage }) {
  console.log(`[direct-push:${label}] creating in-process hyperdht testnet`);
  const { testnet, host, guest, hostStore, guestStore } = await makePeers(label);

  const hostPendingPromise = waitFor(host, 'peer:pending', null, 30_000);

  console.log(`[direct-push:${label}] host creates invite (manual approval)`);
  const invite = await host.createInvite();
  console.log(`[direct-push:${label}]   pairing code:`, invite.pairingCode);

  console.log(`[direct-push:${label}] guest accepts invite`);
  const acceptPromise = guest.acceptInvite(invite.invite, {
    userData: { name: `guest-${label}`, hostname: os.hostname() },
    code: invite.pairingCode,
  });

  console.log(`[direct-push:${label}] waiting for host to see pending request`);
  const pending = await hostPendingPromise;
  console.log(`[direct-push:${label}]   host got pending:`, pending.requestId.slice(0, 8));

  // Apply sabotage right before approve so the host's setup is already
  // done and we're isolating what happens inside approve().
  const restore = sabotage(host, guest);

  const guestPairedPromise = waitFor(guest, 'peer:paired', null, 5000);
  const hostPairedPromise = waitFor(host, 'peer:paired', null, 5000);

  const approveStart = Date.now();
  console.log(`[direct-push:${label}] host approves (sabotage active)`);
  const approved = await host.approve(pending.requestId);
  if (!approved) {
    restore();
    throw new Error('approve returned false');
  }

  console.log(`[direct-push:${label}] waiting for guest peer:paired...`);
  const guestEvent = await guestPairedPromise;
  const guestPairedMs = Date.now() - approveStart;
  console.log(`[direct-push:${label}]   guest paired in ${guestPairedMs}ms`);

  const hostEvent = await hostPairedPromise;

  restore();

  if (hostEvent.discoveryKey !== guestEvent.discoveryKey) {
    throw new Error('discovery key mismatch');
  }
  if (hostEvent.autobaseKey !== guestEvent.autobaseKey) {
    throw new Error('autobaseKey mismatch');
  }
  if (hostEvent.role !== 'host' || guestEvent.role !== 'guest') {
    throw new Error('role mismatch');
  }

  await acceptPromise;
  await cleanup(host, guest);
  await testnet.destroy();
  return { guestPairedMs };
}

async function main() {
  // Scenario 1: DHT put is skipped. The blind-pairing channel send is left
  // intact. This confirms the DHT is no longer on the critical path.
  console.log('[direct-push] scenario 1: DHT put skipped, blind-pairing channel intact');
  const s1 = await runScenario({
    label: 'dht-skip',
    sabotage: (host) => {
      host._testHooks.setSkipDhtPut(true);
      return () => host._testHooks.setSkipDhtPut(false);
    },
  });
  console.log(`[direct-push]   scenario 1: guest paired in ${s1.guestPairedMs}ms`);

  // Scenario 2: both the DHT put and the blind-pairing direct channel send
  // are sabotaged. This is the worst case: nothing except the exec channel
  // can deliver the response. Without the fix the guest would hang on the
  // 30-minute acceptInvite timeout. With the fix the exec channel pushes
  // the response and the guest pairs within a few ms.
  console.log('[direct-push] scenario 2: DHT put skipped AND blind-pairing channel skipped');
  const s2 = await runScenario({
    label: 'both-skip',
    sabotage: (host) => {
      host._testHooks.setSkipDhtPut(true);
      host._testHooks.setSkipBlindPairingChannel(true);
      return () => {
        host._testHooks.setSkipDhtPut(false);
        host._testHooks.setSkipBlindPairingChannel(false);
      };
    },
  });
  console.log(`[direct-push]   scenario 2: guest paired in ${s2.guestPairedMs}ms`);

  // Scenario 2 must complete well under 5s. The 30-min acceptInvite
  // timeout is the failure mode we're guarding against; if scenario 2
  // takes more than a couple of seconds, the exec-channel push isn't
  // actually delivering the response.
  if (s2.guestPairedMs > 2000) {
    console.error(`[direct-push] FAIL: scenario 2 took ${s2.guestPairedMs}ms, expected < 2000ms`);
    process.exit(1);
  }

  console.log('[direct-push] PASS: exec-channel pairing-response delivers the guest pair under 2s even with DHT + blind-pairing channel both sabotaged');
}

main().catch((err) => {
  console.error('[direct-push] ERR:', err);
  process.exit(1);
});
