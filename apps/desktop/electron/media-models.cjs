'use strict';

// Shared load-once/idle-evict shape for the media capabilities (ocr, tts,
// transcribe, diffusion, audiogen): same lifecycle as translate.cjs/chat.cjs,
// factored out since six near-identical copies would just drift apart.

const { ensureModels, checkDiskSpace } = require('../shared/model-fetch.cjs');
const { notify } = require('./model-status.cjs');
const { claim, release, ownerOf } = require('./model-ownership.cjs');

const IDLE_UNLOAD_MS = 20 * 60 * 1000;

// The SDK can refuse a second loadModel for an id it still considers live
// even after this cache lost it. Reusing that id recovers the load.
function parseAlreadyRegisteredModelId(err) {
  const message = err instanceof Error ? err.message : String(err);
  const match = /Model with ID "([^"]+)" is already registered/.exec(message);
  return match ? match[1] : null;
}

/**
 * @param {{ label: string, registryKeys?: string[], buildLoadArgs: (sdk: any) => object, modelName?: string, modelKind?: string }} opts
 */
function createLazyModel({ label, registryKeys, buildLoadArgs, modelName, modelKind }) {
  let modelId = null;
  let idleTimer = null;
  // Diagnostic only, surfaced by callers on a downstream failure: which path
  // handed out the id that then broke (cache hit, fresh load, or adoption
  // of an "already registered" id) narrows down where the real bug is.
  let lastSource = null;

  function clearIdleTimer() {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  function touchIdleTimer() {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      unload().catch((err) => console.warn(`[${label}] idle unload failed`, err && err.message));
    }, IDLE_UNLOAD_MS);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  }

  async function unload() {
    clearIdleTimer();
    if (!modelId) return;
    const id = modelId;
    modelId = null;
    release(id);
    const sdk = require('@qvac/sdk');
    try {
      await sdk.unloadModel({ modelId: id, clearStorage: false });
    } catch (err) {
      console.warn(`[${label}] unload failed`, err && err.message);
    }
    // The SDK refuses a fresh loadModel for this id until unloadModel's
    // effect is visible, so a caller reloading immediately after gets the
    // still-broken id back through "already registered" adoption.
    for (let i = 0; i < 20; i++) {
      const stillThere = await sdk.getLoadedModelInfo({ modelId: id }).then(
        () => true,
        () => false,
      );
      if (!stillThere) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function ensureLoaded() {
    const sdk = require('@qvac/sdk');
    if (modelId) {
      // getLoadedModelInfo throws ModelNotFoundError if the registry has
      // since lost this id (e.g. it was unloaded from under us); a truthy
      // cache alone doesn't mean the SDK still has the model registered.
      const stillRegistered = await sdk.getLoadedModelInfo({ modelId }).then(
        () => true,
        () => false,
      );
      if (stillRegistered) {
        lastSource = 'cache';
        touchIdleTimer();
        return modelId;
      }
      modelId = null;
    }
    if (registryKeys && registryKeys.length > 0) {
      const spaceCheck = await checkDiskSpace(registryKeys);
      if (!spaceCheck.ok) throw new Error(spaceCheck.message);
      await ensureModels(registryKeys, {
        onEvent: (e) => {
          if (modelName && e.phase === 'progress') {
            notify({ name: modelName, kind: modelKind, phase: 'downloading', downloaded: e.downloaded, total: e.total });
          }
        },
      }).catch(() => {});
    }
    if (modelName) notify({ name: modelName, kind: modelKind, phase: 'loading' });
    try {
      modelId = await sdk.loadModel(buildLoadArgs(sdk));
      lastSource = 'fresh';
    } catch (err) {
      const existingId = parseAlreadyRegisteredModelId(err);
      if (!existingId) throw err;
      // Adopting an id another capability owns would let this loader unload
      // their model underneath them. See model-ownership.cjs.
      const owner = ownerOf(existingId);
      if (owner && owner !== label) {
        throw new Error(`Model with ID "${existingId}" is already registered to "${owner}", not "${label}"; refusing to adopt it.`);
      }
      modelId = existingId;
      lastSource = 'adopted';
    }
    claim(modelId, label);
    if (modelName) notify({ name: modelName, kind: modelKind, phase: 'ready' });
    touchIdleTimer();
    return modelId;
  }

  return { ensureLoaded, unload, getModelId: () => modelId, getLastSource: () => lastSource };
}

module.exports = { createLazyModel };
