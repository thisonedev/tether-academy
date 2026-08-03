// How much network a run gets, decided host-side from the code about to run.
// A cached model loads and streams tokens with outbound rules off, so the
// answer is 'none' unless the source shows a download or names a host.
'use strict';

const fs = require('fs');
const path = require('path');

const { scan } = require('../../shared/model-integrity.cjs');

// Read as text: an ESM bundle the Bare worker cannot require.
const REGISTRY_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'node_modules',
  '@qvac',
  'sdk',
  'dist',
  'models',
  'registry',
  'models.js',
);

// Cache entries are prefixed with the SDK's content hash.
const CACHE_HASH_PREFIX = /^[0-9a-f]{16}_/;

// Loopback is not egress; these stay under 'localhost'.
const LOOPBACK_PATTERNS = [
  /\bstartQVACProvider\b/,
  /(?:https?|ws):\/\/(?:localhost|127\.0\.0\.1|\[::1\])/,
];

// Generous on purpose: a false positive costs one prompt, a false negative
// costs a run that hangs with no way to say why.
const EGRESS_PATTERNS = [
  { re: /\bregistry:\/\//, why: 'it names a model registry source directly' },
  { re: /\bhyper:\/\//, why: 'it opens a hyper:// source' },
  {
    re: /\bStdioClientTransport\b/,
    why: 'it runs an MCP server, which reaches the network on the run\'s behalf',
  },
  // `npx --version` is offline; the install forms name a tool that usually is not.
  {
    re: /["']npx["'][\s\S]{0,80}?["'](?:-y|--yes|-p|--package)["']/,
    why: 'it runs a tool fetched with npx',
  },
  { re: /(?:https?|wss?):\/\//, why: 'it contacts a host over the network' },
  { re: /\bfetch\s*\(/, why: 'it calls fetch()' },
];

let registry = null;

/**
 * Model constant name -> what a complete download looks like on disk. Split
 * rather than matched whole-file, so an entry missing a field cannot borrow the
 * next entry's.
 * @returns {Map<string, { modelId: string, expectedSize: number }>}
 */
function modelRegistry() {
  if (registry) return registry;
  registry = new Map();
  let src;
  try {
    src = fs.readFileSync(REGISTRY_PATH, 'utf8');
  } catch {
    // Nothing resolves to "cached", so every run naming a model asks.
    return registry;
  }
  const chunks = src.split("name: '");
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    const name = /^([A-Z][A-Z0-9_]*)'/.exec(chunk);
    if (!name) continue;
    const modelId = /modelId: '([^']+)'/.exec(chunk);
    if (!modelId) continue;
    const size = /expectedSize: (\d+)/.exec(chunk);
    registry.set(name[1], {
      modelId: modelId[1],
      expectedSize: size ? Number(size[1]) : 0,
    });
  }
  return registry;
}

/**
 * Biggest on-disk size per cached file name, hashed and plain: sets and shards
 * repeat a name, and only the complete copy settles it.
 * @returns {Map<string, number>}
 */
function cachedSizes() {
  const out = new Map();
  let entries;
  try {
    entries = scan();
  } catch {
    return out;
  }
  for (const [rel, stat] of entries) {
    const base = path.basename(rel);
    for (const key of new Set([base, base.replace(CACHE_HASH_PREFIX, '')])) {
      out.set(key, Math.max(out.get(key) ?? 0, stat.sizeBytes));
    }
  }
  return out;
}

/**
 * Model constants this source names. Matched on the constants, since the import
 * line has been rewritten to an absolute path by the time it reaches a host.
 * @param {string} code
 * @returns {string[]}
 */
function referencedModels(code) {
  const known = modelRegistry();
  const out = [];
  for (const token of code.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? []) {
    if (known.has(token) && !out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * Models the run names that are not fully downloaded. A partial file counts as
 * missing: the SDK streams to the final path, so an interrupted run leaves one.
 * @param {string} code
 * @returns {string[]}
 */
function missingModels(code) {
  const known = modelRegistry();
  const names = referencedModels(code);
  if (names.length === 0) return [];
  const sizes = cachedSizes();
  return names.filter((name) => {
    const { modelId, expectedSize } = known.get(name);
    const have = sizes.get(modelId) ?? 0;
    return have === 0 || have < expectedSize;
  });
}

/**
 * The network this run should get. `mode` is what the profile enforces;
 * `reason` is what the human answering is shown, and is null only when the run
 * needs no network at all.
 * @param {string} code
 * @returns {{ mode: 'none' | 'localhost' | 'all', reason: string | null, missingModels: string[] }}
 */
function detectNetworkNeed(code) {
  if (typeof code !== 'string' || !code) {
    return { mode: 'none', reason: null, missingModels: [] };
  }

  const missing = missingModels(code);
  if (missing.length > 0) {
    const list = missing.slice(0, 3).join(', ');
    const rest = missing.length > 3 ? ` and ${missing.length - 3} more` : '';
    return {
      mode: 'all',
      reason: `it needs to download ${list}${rest}, which is not on this device yet`,
      missingModels: missing,
    };
  }

  for (const { re, why } of EGRESS_PATTERNS) {
    if (re.test(code)) return { mode: 'all', reason: why, missingModels: [] };
  }

  if (LOOPBACK_PATTERNS.some((re) => re.test(code))) {
    return {
      mode: 'localhost',
      reason: 'it connects to a service running on this machine',
      missingModels: [],
    };
  }

  return { mode: 'none', reason: null, missingModels: [] };
}

module.exports = {
  detectNetworkNeed,
  referencedModels,
  missingModels,
  modelRegistry,
  REGISTRY_PATH,
};
