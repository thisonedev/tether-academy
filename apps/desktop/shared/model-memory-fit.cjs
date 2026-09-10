// Advisory RAM check via the SDK's assessModelFit, run before loadModel.
// Disk space is checkDiskSpace's job in model-fetch.cjs; this is memory only.
'use strict';

/**
 * `unknown` (uncalibrated platform, unsupported engine, missing catalog
 * metadata) is treated as "can't say" and never blocks a load. A failed or
 * unavailable assessment degrades the same way, not as a block.
 * @param {{ model: unknown, workload: object }[]} candidates
 * @param {(input: object) => Promise<object>} [assessModelFitFn] override for tests
 * @returns {Promise<{ ok: boolean, name?: string, message?: string }>}
 */
async function checkMemoryFit(candidates, assessModelFitFn) {
  if (!Array.isArray(candidates) || candidates.length === 0) return { ok: true };

  let assess = assessModelFitFn;
  if (!assess) {
    try {
      assess = require('@qvac/sdk').assessModelFit;
    } catch {
      return { ok: true };
    }
  }
  if (typeof assess !== 'function') return { ok: true };

  let result;
  try {
    result = await assess({ models: candidates, execution: 'sequential', policy: 'interactive-v1' });
  } catch {
    return { ok: true };
  }

  const tooLarge = result?.models?.find((m) => m.verdict === 'likely-too-large');
  if (!tooLarge) return { ok: true };
  return {
    ok: false,
    name: tooLarge.name,
    message: `${tooLarge.name} is unlikely to fit in memory: ${tooLarge.reasons.join('; ')}`,
  };
}

module.exports = { checkMemoryFit };
