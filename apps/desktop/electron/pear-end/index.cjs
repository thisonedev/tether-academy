// Facade owning identity/state/peer lifecycle. identity/manager.cjs and
// state-store.cjs stay directly requirable; peer.cjs runs inside a Bare
// worker, proxied via worker-client.cjs.
const { createManager } = require('../identity/manager.cjs');
const { createStore } = require('../state-store.cjs');
const peer = require('./worker-client.cjs');
const path = require('node:path');

/**
 * @param {string} userDataDir
 * @param {{ getSafeStorage?: () => import('electron').SafeStorage | null }} [opts]
 */
function createPearEnd(userDataDir, opts = {}) {
  const getSafeStorage = opts.getSafeStorage || (() => null);

  let identityManager = null;
  let stateStorePromise = null;
  let readyPromise = null;

  function identity() {
    if (!identityManager) {
      identityManager = createManager(userDataDir, { safeStorage: getSafeStorage() });
    }
    return identityManager;
  }

  function store() {
    if (!stateStorePromise) {
      stateStorePromise = createStore(userDataDir);
    }
    return stateStorePromise;
  }

  // A peer that proved its device key is one this device can recognise again,
  // so record it. Runs on the verification event rather than on pairing: the
  // name a peer reports is unverified, the key it proves is not.
  async function rememberVerifiedPeer(payload) {
    if (!payload?.identityVerified || !payload.verifiedDevicePublicKey) return;
    const idm = identity();
    if (idm.status() !== 'ready') return;
    let userData = null;
    try {
      const known = await peer.listPeers();
      userData = known.find((p) => p.discoveryKey === payload.discoveryKey)?.userData ?? null;
    } catch {
      // The name and address are a convenience; the keys are what the entry is for.
    }
    idm.trustPeer({
      devicePublicKey: payload.verifiedDevicePublicKey,
      identityPublicKey: payload.verifiedIdentityPublicKey,
      name: userData?.name ?? null,
      swarmPublicKey: userData?.swarmPublicKey ?? null,
    });
  }

  // Subscribed once here rather than in initMesh, which runs again after a
  // closeMesh and would leave a second listener recording every peer twice.
  peer.on((event, eventPayload) => {
    if (event !== 'peer:identity-verified') return;
    rememberVerifiedPeer(eventPayload).catch((err) => {
      console.warn('[pear-end] could not record trusted peer:', err?.message ?? err);
    });
  });

  async function initMesh({ bootstrap } = {}) {
    const idm = identity();
    if (idm.status() !== 'ready') return false;
    const st = await store();
    const deviceIdentity = idm.getDeviceIdentity();
    if (!deviceIdentity) return false;
    const { AUDIT_FILE } = require('../../workers/peer/audit-store.cjs');
    const auditPath = path.join(userDataDir, AUDIT_FILE);
    await peer.init({
      store: st,
      deviceIdentity,
      bootstrap,
      secretScheme: idm.secretScheme(),
      attestation: idm.attestation(),
      revokedDevices: idm.revokedDeviceKeys(),
      auditPath,
      // The capability profile's deny list names this path; it must match
      // the actual location even when launched with a `--storage` override.
      userData: userDataDir,
    });
    return true;
  }

  // One init shared by every caller; an init per handler gave the worker a
  // swarm and an event listener per handler.
  async function ensureReady(opts = {}) {
    if (!readyPromise) {
      readyPromise = initMesh(opts);
      // Only success is cached; a failed init is retried by the next caller.
      readyPromise.then(
        (ok) => {
          if (!ok) readyPromise = null;
        },
        () => {
          readyPromise = null;
        },
      );
    }
    return readyPromise;
  }

  // No-op before the worker is up: ensureReady() passes the current list at init.
  async function syncRevocations() {
    try {
      return await peer.setRevokedDevices(identity().revokedDeviceKeys());
    } catch (err) {
      console.warn('[pear-end] revocation sync skipped:', err?.message ?? err);
      return null;
    }
  }

  // Worker process stays alive for a future re-init; dropping the cached
  // promise sends the next ensureReady() through a real init.
  async function closeMesh() {
    readyPromise = null;
    return peer.close();
  }

  // shutdownWorker() (not close()) actually kills the worker OS process.
  async function shutdown() {
    readyPromise = null;
    await peer.shutdownWorker().catch(() => {});
    if (stateStorePromise) {
      const st = await stateStorePromise.catch(() => null);
      if (st) await st.close().catch(() => {});
    }
  }

  return {
    identity,
    store,
    ensureReady,
    syncRevocations,
    closeMesh,
    shutdown,
    peer,
    // Exposed for tests. Two facades cannot run in one process, since
    // worker-client holds the RPC at module scope, so the pairing that
    // triggers this cannot be staged here.
    _rememberVerifiedPeer: rememberVerifiedPeer,
  };
}

module.exports = { createPearEnd };
