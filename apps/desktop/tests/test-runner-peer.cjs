const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const createTestnet = require('hyperdht/testnet.js');
const { createStore } = require('../electron/state-store.cjs');
const { buildLesson } = require('../electron/runner-process.cjs');

function tmpStoreDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ta-runner-peer-${label}-`));
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
  console.log('[test-runner-peer] creating in-process hyperdht testnet (3 nodes)');
  const testnet = await createTestnet(3);
  const bootstrap = testnet.bootstrap;

  const hostDir = tmpStoreDir('host');
  const guestDir = tmpStoreDir('guest');
  const hostStore = await createStore(hostDir);
  const guestStore = await createStore(guestDir);
  console.log('[test-runner-peer] host identity:', hostStore.identity.publicKey.slice(0, 16) + '...');
  console.log('[test-runner-peer] guest identity:', guestStore.identity.publicKey.slice(0, 16) + '...');

  delete require.cache[require.resolve('../electron/peer.cjs')];
  const host = require('../electron/peer.cjs');
  delete require.cache[require.resolve('../electron/peer.cjs')];
  const guest = require('../electron/peer.cjs');

  const hostPaired = waitFor(host, 'peer:paired');
  const guestPaired = waitFor(guest, 'peer:paired');

  await host.init({ store: hostStore, bootstrap });
  await guest.init({ store: guestStore, bootstrap });

  const invite = await host.createInvite({ autoApprove: true });
  console.log('[test-runner-peer] host invite:', invite.pairingCode);

  const acceptResult = await guest.acceptInvite(invite.invite, {
    userData: { name: 'guest-from-runner-peer', hostname: os.hostname() },
    code: invite.pairingCode,
    hostIdentity: hostStore.identity.publicKey,
  });
  console.log('[test-runner-peer] guest accepted, discovery:', acceptResult.discoveryKey.slice(0, 16) + '...');

  const [hostEvent, guestEvent] = await Promise.all([hostPaired, guestPaired]);
  if (hostEvent.discoveryKey !== guestEvent.discoveryKey) {
    console.error('[test-runner-peer] FAIL: discovery key mismatch');
    process.exit(1);
  }

  await waitForExecChannel(guest, guestEvent.discoveryKey);
  console.log('[test-runner-peer] exec channel ready');

  const coursesDir = path.join(__dirname, '..', '..', '..', 'packages', 'courses');
  const lessonSource = [
    'import { loadModel, close } from "@qvac/sdk";',
    '',
    'async function main() {',
    '  process.stdout.write("peer-runner:hello\\n");',
    '  process.stdout.write("peer-runner:platform=" + process.platform + "\\n");',
    '  process.stdout.write("peer-runner:cwd=" + process.cwd() + "\\n");',
    '  process.stdout.write("peer-runner:loadModel=" + (typeof loadModel) + "\\n");',
    '  process.stdout.write("peer-runner:close=" + (typeof close) + "\\n");',
    '}',
    '',
    'main().catch((err) => { console.error("peer-runner:error", err); process.exit(1); });',
  ].join('\n');

  const wrapped = buildLesson({ source: lessonSource, cwd: coursesDir });
  if (!wrapped.includes('close')) {
    console.error('[test-runner-peer] FAIL: buildLesson did not include close in imports');
    process.exit(1);
  }
  if (!wrapped.includes('.finally')) {
    console.error('[test-runner-peer] FAIL: buildLesson did not hook main().catch with .finally');
    process.exit(1);
  }
  console.log('[test-runner-peer] buildLesson wrapped the source, length:', wrapped.length);

  const result = await new Promise((resolve, reject) => {
    let emitter;
    try {
      emitter = guest.exec({
        peerId: guestEvent.discoveryKey,
        code: wrapped,
        mode: 'file',
        argv: ['--no-warnings'],
        cwd: coursesDir,
        fileName: 'snippet.mjs',
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    emitter.on('stdout', (chunk) => { stdout += chunk; });
    emitter.on('stderr', (chunk) => { stderr += chunk; });
    emitter.on('exit', (info) => resolve({ stdout, stderr, ...info }));
    emitter.on('error', reject);
    setTimeout(() => reject(new Error('lesson exec timed out')), 30_000);
  });

  console.log('[test-runner-peer] result:', result);

  if (!result.stdout.includes('peer-runner:hello')) {
    console.error('[test-runner-peer] FAIL: missing hello in stdout');
    process.exit(1);
  }
  if (!result.stdout.includes('peer-runner:platform=')) {
    console.error('[test-runner-peer] FAIL: missing platform line');
    process.exit(1);
  }
  if (!result.stdout.includes('peer-runner:loadModel=function')) {
    console.error('[test-runner-peer] FAIL: loadModel not imported as function (QVAC SDK import did not work)');
    process.exit(1);
  }
  if (!result.stdout.includes('peer-runner:close=function')) {
    console.error('[test-runner-peer] FAIL: close not imported as function');
    process.exit(1);
  }
  if (result.code !== 0) {
    console.error('[test-runner-peer] FAIL: non-zero exit', result);
    process.exit(1);
  }
  console.log('[test-runner-peer] PASS: buildLesson + peer.exec + QVAC SDK import + streaming all work');

  await host.dropPeer(hostEvent.discoveryKey);
  await new Promise((r) => setTimeout(r, 100));
  await host.close();
  await guest.close();
  await testnet.destroy();
  console.log('[test-runner-peer] clean shutdown complete');
}

main().catch((err) => {
  console.error('[test-runner-peer] ERR:', err);
  process.exit(1);
});
