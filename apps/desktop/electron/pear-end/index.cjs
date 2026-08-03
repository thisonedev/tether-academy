// Facade owning identity/state/peer lifecycle. Wraps, doesn't absorb:
// identity/manager.cjs and state-store.cjs stay directly requirable.
// peer.cjs runs inside a Bare worker; worker-client.cjs proxies to it.
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
    });
    return true;
  }

  // One init for every caller. The renderer's mount awaits this from several
  // handlers at once, and an INIT per handler gave the worker a swarm and an
  // event listener per handler.
  async function ensureReady(opts = {}) {
    if (!readyPromise) {
      readyPromise = initMesh(opts);
      // Only success is worth keeping: identity may still be mid-onboarding,
      // and a failed init should be retried by the next caller.
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

  // Revocation only bites once the mesh knows about it. No-op before the worker
  // is up: ensureReady() passes the current list at init.
  async function syncRevocations() {
    try {
      return await peer.setRevokedDevices(identity().revokedDeviceKeys());
    } catch (err) {
      console.warn('[pear-end] revocation sync skipped:', err?.message ?? err);
      return null;
    }
  }

  // Mesh teardown for academy:identity:reset. The worker process stays alive
  // for a future re-init, and dropping the cached promise sends the next
  // ensureReady() through a real init instead of a torn-down swarm.
  async function closeMesh() {
    readyPromise = null;
    return peer.close();
  }

  // Worker process termination before storage close. shutdownWorker() (not
  // close()) actually kills the worker OS process.
  async function shutdown() {
    readyPromise = null;
    await peer.shutdownWorker().catch(() => {});
    if (stateStorePromise) {
      const st = await stateStorePromise.catch(() => null);
      if (st) await st.close().catch(() => {});
    }
  }

  return { identity, store, ensureReady, syncRevocations, closeMesh, shutdown, peer };
}

module.exports = { createPearEnd };
