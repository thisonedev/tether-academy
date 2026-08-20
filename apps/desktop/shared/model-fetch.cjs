// Fetches a missing model from the source the registry names. On 19 and 20
// August the blob path moved no bytes for six minutes on a file Hugging Face
// served at 25 MB/s, and nothing in the SDK gives up on its own.
'use strict';

const fs = require('fs');
const path = require('path');

const { cacheFileName, modelsDir, readRegistry, sideloadModel, sourceUrl } = require('./model-sideload.cjs');

// A short file touched this recently is one something else is still writing.
const ACTIVE_WRITE_MS = 60_000;

/**
 * Whether to leave this model alone: already complete, or being written now,
 * where fetching would race that writer for the same path.
 */
function isPresent(entry, home, now = Date.now()) {
  try {
    const stat = fs.statSync(path.join(modelsDir(home), cacheFileName(entry.registryPath)));
    if (stat.size === entry.expectedSize) return true;
    return now - stat.mtimeMs < ACTIVE_WRITE_MS;
  } catch {
    return false;
  }
}

/**
 * @param {string[]} names registry constants, e.g. ['QWEN3_4B_Q4_K_M']
 * @param {{ home?: string, onEvent?: (e: { name: string, phase: string, downloaded?: number, total?: number, message?: string }) => void }} [opts]
 * @returns {Promise<{ fetched: string[], present: string[], unavailable: string[], failed: string[] }>}
 */
async function ensureModels(names, opts = {}) {
  const out = { fetched: [], present: [], unavailable: [], failed: [] };
  if (!Array.isArray(names) || names.length === 0) return out;
  // For tests that load a model without wanting a gigabyte off the network.
  if (process.env.ACADEMY_NO_DIRECT_FETCH === '1') return out;

  const registry = readRegistry();
  const report = opts.onEvent ?? (() => {});

  for (const name of names) {
    const entry = registry.get(name);
    if (!entry) continue;
    if (isPresent(entry, opts.home)) {
      out.present.push(name);
      continue;
    }
    // Only some entries name a source that can be fetched directly; the rest
    // are left to the SDK, which is the only thing that can reach them.
    try {
      sourceUrl(entry);
    } catch {
      out.unavailable.push(name);
      continue;
    }

    try {
      report({ name, phase: 'start', total: entry.expectedSize });
      await sideloadModel(name, {
        home: opts.home,
        registry,
        onProgress: (downloaded, total) => report({ name, phase: 'progress', downloaded, total }),
      });
      report({ name, phase: 'done' });
      out.fetched.push(name);
    } catch (err) {
      // The SDK still has its own way to get this, so a failure here only
      // costs the shortcut.
      report({ name, phase: 'failed', message: err?.message ?? String(err) });
      out.failed.push(name);
    }
  }
  return out;
}

module.exports = { ensureModels, isPresent, ACTIVE_WRITE_MS };
