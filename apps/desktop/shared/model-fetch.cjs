// Fetches a missing model from the source the registry names. On 19 and 20
// August the blob path moved no bytes for six minutes on a file Hugging Face
// served at 25 MB/s, and nothing in the SDK gives up on its own.
'use strict';

const fs = require('fs');
const path = require('path');

const { cacheFileName, modelsDir, readRegistry, sideloadModel, sourceUrl } = require('./model-sideload.cjs');

// A short file touched this recently is one something else is still writing.
const ACTIVE_WRITE_MS = 60_000;

function formatGiB(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

async function freeBytesAt(dir) {
  try {
    const s = await fs.promises.statfs(dir);
    return Number(s.bsize) * Number(s.bavail);
  } catch {
    return null;
  }
}

/**
 * Checks the models directory's free space against every named model still
 * missing from disk, in order, so a later name in the list can't pass by
 * counting space an earlier name in the same call already claims.
 * @param {number} [freeBytesOverride] Skips the real statfs call; for tests.
 * @returns {Promise<{ ok: boolean, name?: string, message?: string }>}
 */
async function checkDiskSpace(names, home, freeBytesOverride) {
  if (!Array.isArray(names) || names.length === 0) return { ok: true };
  const dir = modelsDir(home);
  let remaining = freeBytesOverride ?? (await freeBytesAt(dir));
  // statfs isn't supported on every platform; don't block a download over a
  // check that couldn't run.
  if (remaining === null) return { ok: true };

  const registry = readRegistry();
  for (const name of names) {
    const entry = registry.get(name);
    if (!entry || !entry.expectedSize || isPresent(entry, home)) continue;
    if (entry.expectedSize > remaining) {
      return {
        ok: false,
        name,
        message:
          `not enough disk space to download ${name}: needs ${formatGiB(entry.expectedSize)}, ` +
          `${formatGiB(remaining)} free`,
      };
    }
    remaining -= entry.expectedSize;
  }
  return { ok: true };
}

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
 * @param {{ home?: string, onEvent?: (e: { name: string, phase: string, downloaded?: number, total?: number, message?: string }) => void, freeBytesOverride?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ fetched: string[], present: string[], unavailable: string[], failed: string[] }>}
 */
async function ensureModels(names, opts = {}) {
  const out = { fetched: [], present: [], unavailable: [], failed: [] };
  if (!Array.isArray(names) || names.length === 0) return out;
  // For tests that load a model without wanting a gigabyte off the network.
  if (process.env.ACADEMY_NO_DIRECT_FETCH === '1') return out;

  const registry = readRegistry();
  const report = opts.onEvent ?? (() => {});
  // Every caller reaches this shortcut differently (some also call
  // checkDiskSpace themselves first to abort before trying at all), but this
  // is the one place that can't be skipped, so the space check lives here too.
  let remaining = opts.freeBytesOverride ?? (await freeBytesAt(modelsDir(opts.home)));

  for (const name of names) {
    if (opts.signal?.aborted) break;
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

    if (remaining !== null && entry.expectedSize > remaining) {
      report({
        name,
        phase: 'failed',
        message:
          `not enough disk space to download ${name}: needs ${formatGiB(entry.expectedSize)}, ` +
          `${formatGiB(remaining)} free`,
      });
      out.failed.push(name);
      continue;
    }

    try {
      report({ name, phase: 'start', total: entry.expectedSize });
      await sideloadModel(name, {
        home: opts.home,
        registry,
        signal: opts.signal,
        onProgress: (downloaded, total) => report({ name, phase: 'progress', downloaded, total }),
      });
      report({ name, phase: 'done' });
      out.fetched.push(name);
      if (remaining !== null) remaining -= entry.expectedSize;
    } catch (err) {
      // The SDK still has its own way to get this, so a failure here only
      // costs the shortcut.
      report({ name, phase: 'failed', message: err?.message ?? String(err) });
      out.failed.push(name);
    }
  }
  return out;
}

module.exports = { ensureModels, isPresent, checkDiskSpace, ACTIVE_WRITE_MS };
