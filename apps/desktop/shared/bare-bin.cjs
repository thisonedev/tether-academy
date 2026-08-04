// @ts-check
'use strict';

// Resolve and prepare the bare-runtime platform binary used by @qvac/sdk,
// done host-side so the sandboxed child never needs to chmod under node_modules.

const fs = require('fs');
const path = require('path');

let cached = null;

/**
 * Absolute path to the platform bare binary, or null if unavailable.
 * Main-process/Node only, not callable from inside a Bare worker.
 * @returns {string | null}
 */
function resolveBareBin() {
  if (cached !== null) return cached || null;
  const { createRequire } = require('module');
  try {
    const qvacEntry = require.resolve('@qvac/sdk');
    const fromQvac = createRequire(qvacEntry);
    const bin = fromQvac('bare-runtime')();
    if (typeof bin === 'string' && bin.length > 0 && fs.existsSync(bin)) {
      cached = bin;
      return bin;
    }
  } catch {
    // fall through
  }
  try {
    const fromLocal = createRequire(__filename);
    const bin = fromLocal('bare-runtime')();
    if (typeof bin === 'string' && bin.length > 0 && fs.existsSync(bin)) {
      cached = bin;
      return bin;
    }
  } catch {
    // fall through
  }
  cached = '';
  return null;
}

/**
 * Ensure the bare binary is executable. Call from the unsandboxed host, passing
 * `preresolved` when calling from a Bare worker.
 * @param {string | null} [preresolved]
 * @returns {string | null} bare path or null
 */
function ensureBareExecutable(preresolved) {
  const bin = preresolved ?? resolveBareBin();
  if (!bin) return null;
  try {
    fs.accessSync(bin, fs.constants.X_OK);
  } catch {
    try {
      fs.chmodSync(bin, 0o755);
    } catch (err) {
      console.warn('[bare-bin] chmod failed:', err?.message ?? err);
    }
  }
  return bin;
}

module.exports = {
  resolveBareBin,
  ensureBareExecutable,
};
