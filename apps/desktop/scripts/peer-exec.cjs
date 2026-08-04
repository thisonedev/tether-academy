const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const createTestnet = require('hyperdht/testnet.js');
const { createStore } = require('../electron/state-store.cjs');
const { createManager } = require('../electron/identity/manager.cjs');

function parseArgs(argv) {
  const out = { invite: null, code: null, exec: null, bootstrap: null, store: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--invite' || a === '-i') out.invite = argv[++i];
    else if (a === '--code' || a === '-c') out.code = argv[++i];
    else if (a === '--exec' || a === '-e') out.exec = argv[++i];
    else if (a === '--bootstrap') out.bootstrap = argv[++i].split(',');
    else if (a === '--store') out.store = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: peer-exec --invite <base64> --code <6char> --exec "<js code>" [--bootstrap host:port] [--store <dir>]');
      process.exit(0);
    }
  }
  return out;
}

function waitFor(emitter, eventName, predicate, timeoutMs = 10000) {
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
  const args = parseArgs(process.argv.slice(2));
  if (!args.invite || !args.code || !args.exec) {
    console.error('Usage: peer-exec --invite <base64> --code <6char> --exec "<js code>"');
    process.exit(1);
  }

  const storeDir = args.store || fs.mkdtempSync(path.join(os.tmpdir(), 'ta-peer-exec-cli-'));
  const store = await createStore(storeDir);
  // A throwaway identity for this CLI run, the same shape main hands the worker.
  const idm = createManager(storeDir, { safeStorage: null });
  await idm.createNew();
  idm.confirmBackup();
  const deviceIdentity = idm.getDeviceIdentity();
  console.log('[peer-exec] guest identity:', deviceIdentity.publicKey.slice(0, 16) + '...');

  const bootstrap = args.bootstrap || (await createTestnet(3)).bootstrap;

  const peer = require('../workers/peer/index.cjs');
  await peer.init({ store, bootstrap, deviceIdentity });

  const pairedPromise = waitFor(peer, 'peer:paired');
  const acceptResult = await peer.acceptInvite(args.invite, {
    userData: { name: 'peer-exec-cli', hostname: os.hostname() },
    code: args.code,
  });
  console.log('[peer-exec] accepted invite, discovery:', acceptResult.discoveryKey.slice(0, 16) + '...');

  const paired = await pairedPromise;

  await new Promise((resolve, reject) => {
    const emitter = peer.exec({ peerId: paired.discoveryKey, code: args.exec });
    emitter.on('stdout', (chunk) => process.stdout.write(chunk));
    emitter.on('stderr', (chunk) => process.stderr.write(chunk));
    emitter.on('exit', (info) => {
      console.error(`[peer-exec] exit code=${info.code} signal=${info.signal ?? ''}`);
      process.exit(info.code ?? 0);
    });
    emitter.on('error', (err) => {
      console.error('[peer-exec] error:', err.message);
      process.exit(1);
    });
    setTimeout(() => reject(new Error('exec timed out')), 60_000);
  });
}

main().catch((err) => {
  console.error('[peer-exec] ERR:', err);
  process.exit(1);
});
