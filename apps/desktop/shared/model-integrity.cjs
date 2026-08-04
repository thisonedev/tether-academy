'use strict';

// Integrity record for the QVAC model cache: local runs hand these weights to
// an unsandboxed native parser, so a swapped file is worth noticing.
//
// Per file: size+mtime (checked every run) and a sha256 (reads every byte, so
// computed only for a chosen set). verifyModels covers the models one run
// names; verifyAll covers the whole cache, on request.

const fs = require('fs');
const os = require('os');
const path = require('path');
const process = require('process');

const { appStateDir } = require('../workers/sandbox/capabilities.cjs');

const MANIFEST_FILE = 'model-integrity.json';
const MANIFEST_VERSION = 1;
// A second of slack: Electron and the Bare worker both write this manifest and
// can report mtimes for the same file a millisecond apart.
const MTIME_SLACK_SEC = 1;

function modelsRoot(home = os.homedir()) {
  return path.join(home, '.qvac', 'models');
}

function manifestPath(stateDir = appStateDir()) {
  return path.join(stateDir, MANIFEST_FILE);
}

function readManifest(stateDir = appStateDir()) {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(stateDir), 'utf8'));
    if (raw?.version === MANIFEST_VERSION && raw.files && typeof raw.files === 'object') {
      return raw;
    }
  } catch {
    // absent or unreadable; a fresh manifest records everything again
  }
  return { version: MANIFEST_VERSION, files: {} };
}

// The tmp name carries the pid since the state directory is shared across app
// instances, which would otherwise race on the same tmp file.
function writeManifest(stateDir, manifest) {
  fs.mkdirSync(stateDir, { recursive: true });
  const tmp = `${manifestPath(stateDir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  try {
    fs.renameSync(tmp, manifestPath(stateDir));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Every regular file under the cache, keyed by its path relative to the root. */
function scan(root = modelsRoot()) {
  const out = new Map();
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        stack.push(childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const st = fs.statSync(path.join(root, childRel));
        out.set(childRel, { sizeBytes: st.size, mtimeSec: Math.floor(st.mtimeMs / 1000) });
      } catch {
        // vanished mid-scan
      }
    }
  }
  return out;
}

function sha256File(abs) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read === 0) break;
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

// setImmediate yields to the loop without draining microtasks first, so the
// swarm breathes between chunks; queueMicrotask would starve it.
function yieldToLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function sha256FileAsync(abs) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (read === 0) break;
      hash.update(buf.subarray(0, read));
      await yieldToLoop();
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function sameStat(known, stat) {
  return (
    !!known &&
    known.sizeBytes === stat.sizeBytes &&
    Math.abs((known.mtimeSec ?? 0) - stat.mtimeSec) <= MTIME_SLACK_SEC
  );
}

/**
 * Stat-only comparison against the manifest. A file seen for the first time
 * is recorded as-is; files whose size or mtime moved are reported.
 * @param {string} stateDir
 * @param {string} [root]
 * @returns {{ changed: string[], added: string[] }}
 */
function syncFast(stateDir = appStateDir(), root = modelsRoot()) {
  const manifest = readManifest(stateDir);
  const seen = scan(root);
  const changed = [];
  const added = [];
  let dirty = false;

  for (const [rel, stat] of seen) {
    const known = manifest.files[rel];
    if (!known) {
      manifest.files[rel] = { ...stat, recordedAt: Date.now(), sha256: null };
      added.push(rel);
      dirty = true;
      continue;
    }
    if (!sameStat(known, stat)) changed.push(rel);
  }
  // An empty scan is more likely a moved cache than an emptied one; don't drop every record.
  if (seen.size > 0) {
    for (const rel of Object.keys(manifest.files)) {
      if (!seen.has(rel)) {
        delete manifest.files[rel];
        dirty = true;
      }
    }
  }
  if (dirty || changed.length > 0) {
    try {
      writeManifest(stateDir, manifest);
    } catch {
      // a read-only state dir costs the record, not the check
    }
  }
  return { changed, added };
}

/**
 * Remove model files that appeared since `before`, for a run that failed.
 * The SDK streams a download to its final path, so a run killed partway
 * leaves a truncated file the manifest would otherwise freeze in place.
 * @param {Set<string>|string[]} before Relative paths present before the run.
 * @param {string} [root]
 * @returns {string[]}
 */
function removeAddedSince(before, root = modelsRoot()) {
  const known = new Set(before);
  const removed = [];
  for (const rel of scan(root).keys()) {
    if (known.has(rel)) continue;
    try {
      fs.rmSync(path.join(root, rel), { force: true });
      removed.push(rel);
    } catch {
      // leave it; syncFast reports it as added on the next run
    }
  }
  return removed;
}

/**
 * Record the current cache as the new baseline after a local run finishes so
 * a freshly downloaded model doesn't read as tampering later.
 * @param {string} [stateDir]
 * @param {string} [root]
 */
function acceptAll(stateDir = appStateDir(), root = modelsRoot()) {
  const manifest = readManifest(stateDir);
  const seen = scan(root);
  const files = {};
  for (const [rel, stat] of seen) {
    const known = manifest.files[rel];
    const unchanged = sameStat(known, stat);
    files[rel] = {
      ...stat,
      recordedAt: unchanged ? known.recordedAt : Date.now(),
      // A rewritten file's old hash says nothing about the new bytes.
      sha256: unchanged ? known.sha256 ?? null : null,
    };
  }
  try {
    writeManifest(stateDir, { version: MANIFEST_VERSION, files });
  } catch {
    // the next run re-baselines
  }
}

// Cache entries carry the SDK's content hash as a name prefix.
const CACHE_HASH_PREFIX = /^[0-9a-f]{16}_/;

/**
 * Content-verify the cached files a run is about to hand to a native parser,
 * by hash rather than the size/mtime fast path. Only the named models are
 * read, keeping cost to what a lesson loads. A file with no hash on record
 * gets one here as its first-sight baseline.
 * @param {string[]} modelIds file names as the SDK's registry publishes them
 * @returns {{ verified: string[], mismatched: string[], recorded: string[] }}
 */
function verifyModels(modelIds, stateDir = appStateDir(), root = modelsRoot()) {
  const wanted = new Set((modelIds ?? []).filter(Boolean));
  const verified = [];
  const mismatched = [];
  const recorded = [];
  if (wanted.size === 0) return { verified, mismatched, recorded };

  const manifest = readManifest(stateDir);
  let dirty = false;
  for (const [rel, stat] of scan(root)) {
    const base = path.basename(rel);
    if (!wanted.has(base) && !wanted.has(base.replace(CACHE_HASH_PREFIX, ''))) continue;
    let sha256;
    try {
      sha256 = sha256File(path.join(root, rel));
    } catch {
      continue;
    }
    const known = manifest.files[rel];
    if (known?.sha256) {
      if (known.sha256 === sha256) verified.push(rel);
      else mismatched.push(rel);
      continue;
    }
    manifest.files[rel] = { ...stat, recordedAt: known?.recordedAt ?? Date.now(), sha256 };
    recorded.push(rel);
    dirty = true;
  }
  if (dirty) {
    try {
      writeManifest(stateDir, manifest);
    } catch {
      // a read-only state dir costs the record, not the check
    }
  }
  return { verified, mismatched, recorded };
}

/**
 * Async version of verifyModels; hash loop yields between chunks. Used on the
 * peer worker's run path, unlike the sync version main uses for the
 * user-triggered academy:models:verify.
 * @param {string[]} modelIds
 * @param {string} [stateDir]
 * @param {string} [root]
 */
async function verifyModelsAsync(modelIds, stateDir = appStateDir(), root = modelsRoot()) {
  const wanted = new Set((modelIds ?? []).filter(Boolean));
  const verified = [];
  const mismatched = [];
  const recorded = [];
  if (wanted.size === 0) return { verified, mismatched, recorded };

  const manifest = readManifest(stateDir);
  let dirty = false;
  for (const [rel, stat] of scan(root)) {
    const base = path.basename(rel);
    if (!wanted.has(base) && !wanted.has(base.replace(CACHE_HASH_PREFIX, ''))) continue;
    let sha256;
    try {
      sha256 = await sha256FileAsync(path.join(root, rel));
    } catch {
      continue;
    }
    const known = manifest.files[rel];
    if (known?.sha256) {
      if (known.sha256 === sha256) verified.push(rel);
      else mismatched.push(rel);
      continue;
    }
    manifest.files[rel] = { ...stat, recordedAt: known?.recordedAt ?? Date.now(), sha256 };
    recorded.push(rel);
    dirty = true;
  }
  if (dirty) {
    try {
      writeManifest(stateDir, manifest);
    } catch {
      // a read-only state dir costs the record, not the check
    }
  }
  return { verified, mismatched, recorded };
}

/**
 * Hash every cached file and compare with the manifest, filling in hashes for
 * entries that only carry size and mtime. Reads every byte (67 GB took 27s on
 * an M-series laptop); keep it off the run path.
 * @param {string} stateDir
 * @param {string} [root]
 * @returns {{ verified: string[], mismatched: string[], recorded: string[] }}
 */
function verifyAll(stateDir = appStateDir(), root = modelsRoot()) {
  const manifest = readManifest(stateDir);
  const seen = scan(root);
  const verified = [];
  const mismatched = [];
  const recorded = [];

  for (const [rel, stat] of seen) {
    let sha256;
    try {
      sha256 = sha256File(path.join(root, rel));
    } catch {
      continue;
    }
    const known = manifest.files[rel];
    if (known?.sha256 && known.sha256 !== sha256) {
      mismatched.push(rel);
      continue;
    }
    manifest.files[rel] = { ...stat, recordedAt: known?.recordedAt ?? Date.now(), sha256 };
    if (known?.sha256) verified.push(rel);
    else recorded.push(rel);
  }
  writeManifest(stateDir, manifest);
  return { verified, mismatched, recorded };
}

/**
 * Async version of verifyAll, for callers on a live event loop.
 * @param {string} [stateDir]
 * @param {string} [root]
 */
async function verifyAllAsync(stateDir = appStateDir(), root = modelsRoot()) {
  const manifest = readManifest(stateDir);
  const seen = scan(root);
  const verified = [];
  const mismatched = [];
  const recorded = [];

  for (const [rel, stat] of seen) {
    let sha256;
    try {
      sha256 = await sha256FileAsync(path.join(root, rel));
    } catch {
      continue;
    }
    const known = manifest.files[rel];
    if (known?.sha256 && known.sha256 !== sha256) {
      mismatched.push(rel);
      continue;
    }
    manifest.files[rel] = { ...stat, recordedAt: known?.recordedAt ?? Date.now(), sha256 };
    if (known?.sha256) verified.push(rel);
    else recorded.push(rel);
  }
  writeManifest(stateDir, manifest);
  return { verified, mismatched, recorded };
}

// Cooldown so a flurry of model downloads does not pin main on the cache.
const SCHEDULE_COOLDOWN_MS = 60_000;
let _lastScheduledAt = 0;
let _inFlight = null;

/**
 * Run a full verify in the background on a cooldown, so a burst of downloads
 * still only walks the cache once. Uses the yielding hash since this runs on
 * the process that owns the window.
 * @param {string} stateDir
 * @param {string} [root]
 */
function scheduleVerifyAll(stateDir = appStateDir(), root = modelsRoot()) {
  if (_lastScheduledAt && Date.now() - _lastScheduledAt < SCHEDULE_COOLDOWN_MS) {
    return _inFlight ?? Promise.resolve();
  }
  _lastScheduledAt = Date.now();
  _inFlight = verifyAllAsync(stateDir, root).catch((err) => {
    console.warn('[model-integrity] scheduleVerifyAll failed:', err?.message ?? err);
    return null;
  });
  return _inFlight;
}

module.exports = {
  MANIFEST_FILE,
  modelsRoot,
  manifestPath,
  readManifest,
  writeManifest,
  scan,
  sha256File,
  sha256FileAsync,
  yieldToLoop,
  syncFast,
  verifyModels,
  verifyModelsAsync,
  scheduleVerifyAll,
  acceptAll,
  removeAddedSince,
  verifyAll,
  verifyAllAsync,
};