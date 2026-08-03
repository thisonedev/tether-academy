// Shared fixtures. Every factory takes brittle's `t` and registers its own
// teardown, so a failing assertion cannot leak a testnet, store, or temp dir.
// Do not close these by hand. Teardown order, ascending: 1 peers, 2 stores,
// 3 testnet, 4 temp dirs.
'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const createTestnet = require('hyperdht/testnet.js');
const hypercoreCrypto = require('hypercore-crypto');
const IdentityKey = require('keet-identity-key');

const { createStore } = require('../../electron/state-store.cjs');

const PEER_MODULE = '../../workers/peer/index.cjs';

// Peer-exec runs the child on Bare: no `process` global, no node: builtins, and
// no resolution root at the lesson workspace. buildLesson handles this for a
// real lesson; a raw test snippet needs the same.
const BARE_MODULES = {
  process: 'bare-process',
  fs: 'bare-fs',
  os: 'bare-os',
  path: 'bare-path',
  child_process: 'bare-subprocess',
  // Test-only, for probing egress.
  net: 'bare-tcp',
};

function bareModulePath(name) {
  const target = BARE_MODULES[name];
  if (!target) throw new Error(`bare helpers: no Bare module for "${name}"`);
  return require.resolve(target);
}

/**
 * Bindings for an inline snippet, which bare evaluates as CommonJS.
 * @param {string[]} names keys of BARE_MODULES
 * @returns {string}
 */
function bareRequires(...names) {
  return names
    .map((name) => `const ${name} = require(${JSON.stringify(bareModulePath(name))});`)
    .join('\n');
}

/**
 * The same bindings for file mode, which bare evaluates as an ES module. A
 * snippet cannot mix the two forms.
 * @param {string[]} names keys of BARE_MODULES
 * @returns {string}
 */
function bareImports(...names) {
  return names
    .map((name) => `import ${name} from ${JSON.stringify(bareModulePath(name))};`)
    .join('\n');
}

// peer.cjs is a module-level singleton, so two peers in the same process need
// separate module instances. Clearing the require cache is the only way to get
// a fresh copy; a plain require() hands back the same object.
function freshRequire(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(resolved);
}

function tmpDir(t, label = 'tmp') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ta-${label}-`));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }), { order: 4 });
  return dir;
}

// peer.close() can hang if a swarm connection does not drain. Bounding it here
// stops a slow close from stalling the suite. The bound lives in this single
// place instead of being re-invented per file, and the hang is a known issue,
// not something the tests should paper over silently.
const CLOSE_TIMEOUT_MS = 2000;

function boundedClose(resource, label) {
  return async () => {
    let timer;
    const bail = new Promise((resolve) => {
      timer = setTimeout(() => {
        console.warn(`[helpers] ${label}.close() exceeded ${CLOSE_TIMEOUT_MS}ms; continuing`);
        resolve();
      }, CLOSE_TIMEOUT_MS);
    });
    try {
      await Promise.race([resource.close(), bail]);
    } finally {
      clearTimeout(timer);
    }
  };
}

async function createTestnetFor(t, size = 3) {
  const testnet = await createTestnet(size);
  t.teardown(() => testnet.destroy(), { order: 3 });
  return testnet;
}

async function createStoreFor(t, label) {
  const store = await createStore(tmpDir(t, label));
  t.teardown(boundedClose(store, `store(${label})`), { order: 2 });
  return store;
}

// Creates `n` independent peers on a shared in-process testnet. By convention
// peers[0] is the host and the rest are guests. `opts.initFor(i)` supplies
// per-peer init options, for anything each peer must not share.
async function createPeers(t, n, opts = {}) {
  const testnet = opts.testnet || (await createTestnetFor(t));
  const bootstrap = testnet.bootstrap;
  const label = opts.label ? `${opts.label}-` : '';

  const peers = [];
  const stores = [];
  const identities = [];
  for (let i = 0; i < n; i++) {
    const name = i === 0 ? `${label}host` : `${label}guest${i}`;
    const store = await createStoreFor(t, name);
    const peer = freshRequire(PEER_MODULE);
    t.teardown(boundedClose(peer, `peer(${name})`), { order: 1 });
    const init = {
      store,
      bootstrap,
      // peer.init requires one. Tests that care about the identity supply
      // their own through initFor, which wins over this.
      ...(await attestedIdentity()),
      // worker-client passes this in production; the node runtime needs it.
      execPath: require('electron'),
      ...(opts.init || {}),
      ...(opts.initFor ? await opts.initFor(i) : {}),
    };
    await peer.init(init);
    peers.push(peer);
    stores.push(store);
    identities.push(init.deviceIdentity);
  }

  return { testnet, bootstrap, peers, stores, identities };
}

// A device key plus the keet-identity-key chain binding it to a fresh root
// identity: what peer.init receives from the identity manager in the real app.
async function attestedIdentity() {
  const mnemonic = IdentityKey.generateMnemonic();
  const id = await IdentityKey.from({ mnemonic });
  const device = hypercoreCrypto.keyPair();
  const proof = await id.bootstrap(device.publicKey);
  id.clear();

  const devicePublicKey = device.publicKey.toString('hex');
  const identityPublicKey = Buffer.from(id.identityPublicKey).toString('hex');
  return {
    deviceIdentity: {
      publicKey: devicePublicKey,
      privateKey: device.secretKey.subarray(0, 32).toString('hex'),
      secretKey: device.secretKey.toString('hex'),
      createdAt: Date.now(),
      identityPublicKey,
      source: 'tether-academy',
    },
    attestation: {
      proof: Buffer.from(proof).toString('base64'),
      identityPublicKey,
      devicePublicKey,
    },
  };
}

// peer.cjs exposes a custom emitter: `on(fn)` takes an (event, payload) handler
// and returns an unsubscribe function. It is not a node EventEmitter.
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

// Pairs peers[0] (host) with one guest and resolves once both sides report it.
async function pairPeers(host, guest, opts = {}) {
  const hostPaired = waitFor(host, 'peer:paired', null, opts.timeoutMs);
  const guestPaired = waitFor(guest, 'peer:paired', null, opts.timeoutMs);

  const invite = await host.createInvite({ autoApprove: true, ...(opts.invite || {}) });
  await guest.acceptInvite(invite.invite, {
    userData: { name: 'test-guest', ...(opts.userData || {}) },
    code: invite.pairingCode,
    ...(opts.accept || {}),
  });

  const [hostEvent, guestEvent] = await Promise.all([hostPaired, guestPaired]);
  return { invite, hostEvent, guestEvent };
}

// A device identity with the fields peer.cjs expects. The worker receives an
// already-decrypted identity from the Electron main process, so tests that
// exercise the worker do not need a real identity manager.
function fakeDeviceIdentity() {
  const kp = hypercoreCrypto.keyPair();
  return {
    publicKey: kp.publicKey.toString('hex'),
    privateKey: kp.secretKey.toString('hex').slice(0, 64),
    secretKey: kp.secretKey.toString('hex'),
    createdAt: Date.now(),
    identityPublicKey: kp.publicKey.toString('hex'),
    source: 'tether-academy',
  };
}

// Peers that talk to a real Bare worker over bare-rpc, rather than requiring
// peer.cjs in-process. Each client spawns its own worker, so they need separate
// module instances just as the in-process peers do.
async function createWorkerPeers(t, n, opts = {}) {
  const testnet = opts.testnet || (await createTestnetFor(t));

  const clients = [];
  for (let i = 0; i < n; i++) {
    const client = freshRequire('../../electron/pear-end/worker-client.cjs');
    t.teardown(() => client.shutdownWorker(), { order: 1 });
    await client.init({
      deviceIdentity: fakeDeviceIdentity(),
      bootstrap: testnet.bootstrap,
      ...(opts.init || {}),
    });
    clients.push(client);
  }

  return { testnet, clients };
}

// The exec protomux channel opens shortly after pairing, independently of the
// peer:paired event. A no-op exec is the only probe for whether it is ready;
// without this the first real exec races the channel and throws
// "no exec channel".
async function waitForExecChannel(peer, discoveryKey, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await runExec(peer, { peerId: discoveryKey, code: 'null' }, 2000);
      return;
    } catch (err) {
      if (!String(err.message).includes('no exec channel')) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`exec channel never opened for ${discoveryKey.slice(0, 16)}...`);
}

// Collects a full exec run into { stdout, stderr, code, signal }.
function runExec(peer, opts, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let emitter;
    try {
      emitter = peer.exec(opts);
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`exec timed out after ${timeoutMs}ms`)), timeoutMs);

    emitter.on('stdout', (chunk) => {
      stdout += chunk;
      opts.onStdout?.(stdout, emitter);
    });
    emitter.on('stderr', (chunk) => {
      stderr += chunk;
    });
    emitter.on('exit', (info) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, ...info });
    });
    emitter.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// A paired host/guest with the exec channel already open: the starting point
// for every peer-exec test.
async function pairForExec(t, label) {
  const { peers: [host, guest], testnet } = await createPeers(t, 2, { label });
  const { hostEvent, guestEvent } = await pairPeers(host, guest, {
    userData: { name: `guest-${label}` },
  });
  await waitForExecChannel(guest, guestEvent.discoveryKey);
  return { host, guest, testnet, discoveryKey: guestEvent.discoveryKey, hostEvent, guestEvent };
}

module.exports = {
  attestedIdentity,
  bareImports,
  bareRequires,
  createPeers,
  createWorkerPeers,
  fakeDeviceIdentity,
  createStoreFor,
  createTestnetFor,
  freshRequire,
  pairForExec,
  pairPeers,
  runExec,
  tmpDir,
  waitFor,
  waitForExecChannel,
};
