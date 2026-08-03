'use strict';

// Integrity record for the QVAC model cache. A local run hands these weights to
// a native parser with no sandbox around it, so a swapped file is worth
// noticing.
//
// Per file: size+mtime, which every run checks, and a sha256, which reads every
// byte and so is computed for a chosen set. verifyModels does it for the models
// one run names; verifyAll does it for the whole cache, on request. The manifest
// lives in the app state directory, which no sandbox profile grants.

const fs = require('fs');
const os = require('os');
const path = require('path');
const process = require('process');

const { appStateDir } = require('../workers/sandbox/capabilities.cjs');

const MANIFEST_FILE = 'model-integrity.json';
const MANIFEST_VERSION = 1;
// Whole seconds, compared with a second of slack. Electron and the Bare worker
// both read and write this manifest, and they report mtimes for the same file a
// millisecond apart.
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

// The tmp name carries the pid because the state directory is per-machine, not
// per-instance: two app instances sharing it would otherwise write the same
// tmp file and the loser's rename would fail with ENOENT.
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
// swarm breathes between chunks. queueMicrotask drains microtasks before I/O
// runs, which is the starvation this exists to avoid.
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
 * Stat-only comparison against the manifest. A file seen for the first time is
 * recorded as it stands, since there is nothing yet to compare it against.
 * Files whose size or mtime moved are reported.
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
  // An empty scan is more likely a cache that moved than one that emptied, and
  // forgetting every record would let the next rewrite pass as a new file.
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
 *
 * The SDK streams a download to its final path, so a run killed partway leaves
 * a truncated file that the next run's profile then freezes, and the SDK can
 * never replace it. A completed download gets removed too and simply refetched.
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
 * Take the cache as it stands as the new baseline, which a local run does after
 * it finishes: it may have downloaded a model, and without this that download
 * would read as tampering and leave every later run reporting it.
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
 * Content-verify the cached files a run is about to hand to a native parser.
 *
 * The fast path compares size and mtime, and `touch -r` restores both, so a
 * local attacker who bothers walks through it. For a file that will be parsed,
 * the hash is the answer that counts.
 *
 * Only the named models are read, so the cost is the one model a lesson loads
 * instead of the whole cache. A file with no hash on record gets one here, on
 * the reasoning that first sight is the best evidence available; from then on
 * it is the hash that decides.
 *
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
 * Async version of verifyModels. Same logic, hash loop yields between chunks.
 * The peer worker uses this on the run path; main keeps the sync version for
 * academy:models:verify, which a user asks for and is not on any event loop.
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
 * entries that only carry size and mtime. Reads every byte in the cache: 67 GB
 * took 27s on an M-series laptop. Keep it off the run path.
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
 * Async version of verifyAll, for callers on a live event loop. Same logic,
 * hash loop yields between chunks.
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
 * Run a full verify in the background on a cooldown. Main calls this after
 * each model download and once on idle at startup. The next call within the
 * cooldown returns the in-flight promise, so a burst of downloads still only
 * walks the cache once.
 *
 * Uses the yielding hash: this runs on the process that owns the window, which
 * the sync one freezes for as long as the whole cache takes to read.
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