'use strict';

// Shared load-once/idle-evict shape for the media capabilities (ocr, tts,
// transcribe, diffusion, audiogen): same lifecycle as translate.cjs/chat.cjs,
// factored out since six near-identical copies would just drift apart.

const { ensureModels } = require('../shared/model-fetch.cjs');

const IDLE_UNLOAD_MS = 20 * 60 * 1000;

/**
 * @param {{ label: string, registryKeys?: string[], buildLoadArgs: (sdk: any) => object }} opts
 */
function createLazyModel({ label, registryKeys, buildLoadArgs }) {
  let modelId = null;
  let idleTimer = null;

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
    const sdk = require('@qvac/sdk');
    try {
      await sdk.unloadModel({ modelId: id, clearStorage: false });
    } catch (err) {
      console.warn(`[${label}] unload failed`, err && err.message);
    }
  }

  async function ensureLoaded() {
    if (modelId) {
      touchIdleTimer();
      return modelId;
    }
    const sdk = require('@qvac/sdk');
    if (registryKeys && registryKeys.length > 0) await ensureModels(registryKeys, {}).catch(() => {});
    modelId = await sdk.loadModel(buildLoadArgs(sdk));
    touchIdleTimer();
    return modelId;
  }

  return { ensureLoaded, unload, getModelId: () => modelId };
}

module.exports = { createLazyModel };
