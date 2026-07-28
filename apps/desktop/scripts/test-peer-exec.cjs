const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const createTestnet = require('hyperdht/testnet.js');
const { createStore } = require('../electron/state-store.cjs');

function tmpStoreDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ta-peer-exec-${label}-`));
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

async function waitForExecChannel(peerModule, discoveryKeyHex, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        let emitter;
        try {
          emitter = peerModule.exec({ peerId: discoveryKeyHex, code: 'null' });
        } catch (err) {
          reject(err);
          return;
        }
        emitter.on('exit', () => resolve());
        emitter.on('error', reject);
        setTimeout(() => reject(new Error('warmup exec timed out')), 2000);
      });
      return;
    } catch (err) {
      if (!String(err.message).includes('no exec channel')) throw err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`exec channel never opened for ${discoveryKeyHex.slice(0, 16)}...`);
}

async function main() {
  console.log('[test-peer-exec] creating in-process hyperdht testnet (3 nodes)');
  const testnet = await createTestnet(3);
  const bootstrap = testnet.bootstrap;

  const hostDir = tmpStoreDir('host');
  const guestDir = tmpStoreDir('guest');
  const hostStore = await createStore(hostDir);
  const guestStore = await createStore(guestDir);
  console.log('[test-peer-exec] host identity:', hostStore.identity.publicKey.slice(0, 16) + '...');
  console.log('[test-peer-exec] guest identity:', guestStore.identity.publicKey.slice(0, 16) + '...');

  delete require.cache[require.resolve('../electron/peer.cjs')];
  const host = require('../electron/peer.cjs');
  delete require.cache[require.resolve('../electron/peer.cjs')];
  const guest = require('../electron/peer.cjs');

  const hostPairedPromise = waitFor(host, 'peer:paired');
  const guestPairedPromise = waitFor(guest, 'peer:paired');

  await host.init({ store: hostStore, bootstrap });
  await guest.init({ store: guestStore, bootstrap });

  const invite = await host.createInvite({ autoApprove: true });
  console.log('[test-peer-exec] host created invite, pairing code:', invite.pairingCode);

  const acceptResult = await guest.acceptInvite(invite.invite, {
    userData: { name: 'guest-from-exec-test', hostname: os.hostname() },
    code: invite.pairingCode,
    hostIdentity: hostStore.identity.publicKey,
  });
  console.log('[test-peer-exec] guest accepted, discovery:', acceptResult.discoveryKey.slice(0, 16) + '...');

  const [hostEvent, guestEvent] = await Promise.all([hostPairedPromise, guestPairedPromise]);
  if (hostEvent.discoveryKey !== guestEvent.discoveryKey) {
    console.error('[test-peer-exec] FAIL: discovery key mismatch');
    process.exit(1);
  }
  console.log('[test-peer-exec] paired, discovery:', guestEvent.discoveryKey.slice(0, 16) + '...');

  await waitForExecChannel(guest, guestEvent.discoveryKey);
  console.log('[test-peer-exec] exec channel ready');

  const code = [
    'process.stdout.write("hi from host\\n");',
    'process.stdout.write("platform: " + process.platform + "\\n");',
    'process.exit(0);',
  ].join('');

  const result = await new Promise((resolve, reject) => {
    const emitter = guest.exec({ peerId: guestEvent.discoveryKey, code });
    let stdout = '';
    let stderr = '';
    emitter.on('stdout', (chunk) => { stdout += chunk; });
    emitter.on('stderr', (chunk) => { stderr += chunk; });
    emitter.on('exit', (info) => resolve({ stdout, stderr, ...info }));
    emitter.on('error', reject);
    setTimeout(() => reject(new Error('exec timed out')), 10_000);
  });

  console.log('[test-peer-exec] exec result:', result);

  if (!result.stdout.includes('hi from host')) {
    console.error('[test-peer-exec] FAIL: missing expected stdout');
    process.exit(1);
  }
  if (!result.stdout.includes('platform:')) {
    console.error('[test-peer-exec] FAIL: missing platform line');
    process.exit(1);
  }
  if (result.code !== 0) {
    console.error('[test-peer-exec] FAIL: non-zero exit', result);
    process.exit(1);
  }
  if (result.stderr.length > 0) {
    console.error('[test-peer-exec] FAIL: unexpected stderr', result.stderr);
    process.exit(1);
  }
  console.log('[test-peer-exec] PASS: guest exec ran on host, stdout streamed, exit 0');

  const errCode = 'process.stderr.write("boom\\n"); process.exit(7);';
  const errResult = await new Promise((resolve, reject) => {
    const emitter = guest.exec({ peerId: guestEvent.discoveryKey, code: errCode });
    let stderr = '';
    emitter.on('stderr', (chunk) => { stderr += chunk; });
    emitter.on('exit', (info) => resolve({ stderr, ...info }));
    emitter.on('error', reject);
    setTimeout(() => reject(new Error('exec timed out')), 10_000);
  });
  if (errResult.code !== 7) {
    console.error('[test-peer-exec] FAIL: expected exit 7, got', errResult);
    process.exit(1);
  }
  if (!errResult.stderr.includes('boom')) {
    console.error('[test-peer-exec] FAIL: expected stderr "boom"');
    process.exit(1);
  }
  console.log('[test-peer-exec] PASS: stderr streams and exit code propagates');

  await host.dropPeer(hostEvent.discoveryKey);
  await new Promise((r) => setTimeout(r, 100));
  await host.close();
  await guest.close();
  await testnet.destroy();
  console.log('[test-peer-exec] clean shutdown complete');
}

main().catch((err) => {
  console.error('[test-peer-exec] ERR:', err);
  process.exit(1);
});
