// Lists, sizes, and removes downloaded QVAC models. Models live under
// `<HOME>/.qvac/models/` as single files, `sharded/<key>/`, or `sets/<key>/`;

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { CHAT_PRESETS } = require('../shared/chat-presets.cjs');
const { consumersForModelId, allPlaygroundModelIds } = require('./model-consumers.cjs');
const { cacheFileName, readRegistry } = require('../shared/model-sideload.cjs');

const SINGLE_HASH_RE = /^([0-9a-f]{16})_(.+)$/;

const CHAT_MODEL_HINTS = {
  'Qwen3-0.6B-Q4_0.gguf': {
    family: 'chat',
    sizeBytes: 480 * 1024 * 1024,
    minRamBytes: 4 * 1024 ** 3,
    gpu: 'optional',
  },
  'Qwen3-1.7B-Q4_0.gguf': {
    family: 'chat',
    sizeBytes: 1.1 * 1024 ** 3,
    minRamBytes: 8 * 1024 ** 3,
    gpu: 'optional',
  },
  'Qwen3-4B-Q4_K_M.gguf': {
    family: 'chat',
    sizeBytes: 2.4 * 1024 ** 3,
    minRamBytes: 12 * 1024 ** 3,
    gpu: 'preferred',
  },
  'Qwen3-8B-Q4_K_M.gguf': {
    family: 'chat',
    sizeBytes: 4.7 * 1024 ** 3,
    minRamBytes: 20 * 1024 ** 3,
    gpu: 'preferred',
  },
};

// Filename -> family fallback for non-chat models. Used only when no hint matches.
const FILENAME_FAMILY_HINTS = [
  { match: /-?(embedding|gte|embed)/i, family: 'embedding' },
  { match: /-?(whisper|parakeet|diar|sortformer|silero|tts|chatterbox|supertonic|nmt|translat)/i, family: 'audio' },
  { match: /-?(sdcpp|stable-diffusion|flux)/i, family: 'image' },
  { match: /-?(wan|t2v|i2v|svd)/i, family: 'video' },
  { match: /-?(vla|pi0|smolvla|libero)/i, family: 'other' },
  { match: /-?(ocr|vision|sdvlm|smolvlm|clip)/i, family: 'image' },
  // Any other Qwen3 instruct GGUF: someone may point the AI bot at it even
  // though it's not one of the small CHAT_MODEL_HINTS presets. VL is
  // multimodal, not a plain chat model; embedding is matched above already.
  { match: /^Qwen3(?!VL)/i, family: 'chat' },
];

function familyForName(name) {
  const hint = CHAT_MODEL_HINTS[name];
  if (hint) return hint.family;
  for (const { match, family } of FILENAME_FAMILY_HINTS) {
    if (match.test(name)) return family;
  }
  return 'other';
}

function hintsForName(name) {
  return CHAT_MODEL_HINTS[name] ?? { sizeBytes: 0, minRamBytes: 0, gpu: 'optional' };
}

let usageMap = null;
function loadUsageMap() {
  if (usageMap !== null) return usageMap;
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'model-usage.json'), 'utf-8');
    usageMap = JSON.parse(raw);
    if (!usageMap || typeof usageMap !== 'object') usageMap = {};
  } catch {
    usageMap = {};
  }
  return usageMap;
}

let descriptionMap = null;
function loadDescriptionMap() {
  if (descriptionMap !== null) return descriptionMap;
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'model-descriptions.json'), 'utf-8');
    descriptionMap = JSON.parse(raw);
    if (!descriptionMap || typeof descriptionMap !== 'object') descriptionMap = {};
  } catch {
    descriptionMap = {};
  }
  return descriptionMap;
}

function modelsRoot() {
  return path.join(os.homedir(), '.qvac', 'models');
}

async function safeStat(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

async function dirSize(dir) {
  let total = 0;
  let count = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        const s = await safeStat(abs);
        if (s) {
          total += s.size;
          count += 1;
        }
      }
    }
  }
  return { total, count };
}

function displayNameFromSingle(filename) {
  const m = SINGLE_HASH_RE.exec(filename);
  return m ? m[2] : filename;
}

async function listModels() {
  const root = modelsRoot();
  const rootStat = await safeStat(root);
  if (!rootStat || !rootStat.isDirectory()) return [];

  const usage = loadUsageMap();
  const descriptions = loadDescriptionMap();
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    const abs = path.join(root, entry.name);
    if (entry.isFile()) {
      const s = await safeStat(abs);
      if (!s) continue;
      const hashMatch = SINGLE_HASH_RE.exec(entry.name);
      const displayName = displayNameFromSingle(entry.name);
      const sizes = knownGoodSizes(displayName);
      out.push({
        id: entry.name,
        name: displayName,
        sizeBytes: s.size,
        mtimeMs: s.mtimeMs,
        kind: 'single',
        sourceHash: hashMatch ? hashMatch[1] : '',
        fileCount: 1,
        usedIn: usage[displayName] ?? [],
        description: descriptions[displayName] ?? '',
        // No registry entry to check size against: assume complete.
        complete: sizes ? sizes.has(s.size) : true,
      });
    } else if (entry.isDirectory() && (entry.name === 'sharded' || entry.name === 'sets')) {
      const groups = await fsp.readdir(abs, { withFileTypes: true });
      for (const group of groups) {
        if (!group.isDirectory()) continue;
        const groupAbs = path.join(abs, group.name);
        const { total, count } = await dirSize(groupAbs);
        // Empty companion dirs still have to show up: otherwise the catalogue
        // row is 0 B with no id, and Settings can't delete the leftover.
        out.push({
          id: path.join(entry.name, group.name),
          name: group.name,
          sizeBytes: total,
          kind: entry.name === 'sharded' ? 'sharded' : 'set',
          sourceHash: '',
          fileCount: count,
          usedIn: usage[group.name] ?? [],
          description: descriptions[group.name] ?? '',
          // No reliable per-shard ground truth here (see pruneIncompleteDownloads).
          complete: count > 0,
        });
      }
    }
  }

  out.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return out;
}

async function removeModel(id) {
  const root = modelsRoot();
  const abs = path.join(root, id);
  // Refuse to escape the models root. `id` comes from the renderer.
  const resolved = path.resolve(abs);
  if (!resolved.startsWith(path.resolve(root) + path.sep) && resolved !== path.resolve(root)) {
    throw new Error('refusing to delete outside the models directory');
  }
  const stat = await safeStat(resolved);
  if (!stat) return { removed: 0, freedBytes: 0 };

  let freedBytes = 0;
  let removed = 0;
  if (stat.isDirectory()) {
    const { total, count } = await dirSize(resolved);
    freedBytes = total;
    removed = count;
    await fsp.rm(resolved, { recursive: true, force: true });
  } else {
    freedBytes = stat.size;
    removed = 1;
    await fsp.unlink(resolved);
  }
  return { removed, freedBytes };
}

// Lazy so a missing @qvac/sdk/models can't take down list/remove on startup.
let _sdkRegistryModels = null;
function sdkRegistryModels() {
  if (_sdkRegistryModels === null) {
    try {
      const { models } = require('@qvac/sdk/models');
      _sdkRegistryModels = Array.isArray(models) ? models : [];
    } catch (err) {
      console.warn('[models] could not load @qvac/sdk registry', err && err.message);
      _sdkRegistryModels = [];
    }
  }
  return _sdkRegistryModels;
}

// Real HF download URL for a registry entry, for loadModel's fallbackSrc when
// the P2P registry is unreachable. Only 'hf'-sourced, single-file entries
// have one; the SDK rejects fallbackSrc for sharded/companion-set models, and
// 's3'-sourced entries have no public mirror to construct one from.
// Takes the resolved registry constant itself (e.g. sdk.QWEN3_8B_INST_Q4_K_M),
// not a modelId: several constants can share one modelId, and only the exact
// entry a caller is actually loading tells us which source it uses.
function hfFallbackSrc(entry) {
  if (!entry || entry.registrySource !== 'hf' || entry.shardMetadata || entry.companionSet) return undefined;
  return `https://huggingface.co/${entry.registryPath.replace('/blob/', '/resolve/')}`;
}

// Memoized filename -> set of valid download sizes, from @qvac/sdk's registry
// (multiple entries when a file has more than one legitimate source).
let _knownSizesByName = null;
function knownGoodSizes(filename) {
  if (_knownSizesByName === null) {
    _knownSizesByName = new Map();
    for (const entry of sdkRegistryModels()) {
      if (!entry.modelId || !entry.expectedSize) continue;
      const sizes = _knownSizesByName.get(entry.modelId) ?? new Set();
      sizes.add(entry.expectedSize);
      _knownSizesByName.set(entry.modelId, sizes);
    }
  }
  return _knownSizesByName.get(filename) ?? null;
}

// Catalogue fallback so an undownloaded row shows the registry size instead of 0 B.
let _expectedSizeByName = null;
function expectedSizeForName(name) {
  if (_expectedSizeByName === null) {
    _expectedSizeByName = new Map();
    for (const entry of sdkRegistryModels()) {
      if (entry.modelId && entry.expectedSize) {
        const prev = _expectedSizeByName.get(entry.modelId) ?? 0;
        _expectedSizeByName.set(entry.modelId, Math.max(prev, entry.expectedSize));
      }
      const set = entry.companionSet;
      if (set && set.setKey) {
        const sum = (set.files ?? []).reduce((s, f) => s + (f.expectedSize || 0), 0);
        if (sum > 0) {
          const prev = _expectedSizeByName.get(set.setKey) ?? 0;
          _expectedSizeByName.set(set.setKey, Math.max(prev, sum));
        }
      }
    }
  }
  return _expectedSizeByName.get(name) ?? 0;
}

// setKey <-> member filenames. BCI_WINDOWED is both sets/abc845…/ and
// ggml-bci-windowed.bin in the catalogue; downloading one must count as both.
let _companionIndex = null;
function companionIndex() {
  if (_companionIndex === null) {
    const setKeyToMembers = new Map();
    const memberToSetKey = new Map();
    for (const entry of sdkRegistryModels()) {
      const set = entry.companionSet;
      if (!set || !set.setKey) continue;
      const members = (set.files ?? []).map((f) => f.targetName).filter(Boolean);
      setKeyToMembers.set(set.setKey, members);
      for (const member of members) memberToSetKey.set(member, set.setKey);
    }
    _companionIndex = { setKeyToMembers, memberToSetKey };
  }
  return _companionIndex;
}

// A download in flight is short and growing, which reads exactly like the
// truncated leftover this sweep is for. Deleting one does not stop the writer:
// it finishes into an unlinked inode and the loader then finds no file.
const ACTIVE_WRITE_MS = 60_000;

async function pruneIncompleteDownloads({ now = Date.now() } = {}) {
  const items = await listModels();
  const removed = [];
  let freedBytes = 0;
  for (const item of items) {
    if (item.kind !== 'single') continue;
    const sizes = knownGoodSizes(item.name);
    if (!sizes || sizes.has(item.sizeBytes)) continue;
    if (typeof item.mtimeMs === 'number' && now - item.mtimeMs < ACTIVE_WRITE_MS) {
      console.warn(`[models] left ${item.name} alone; written to in the last minute`);
      continue;
    }
    try {
      const r = await removeModel(item.id);
      freedBytes += r.freedBytes;
      removed.push(item.name);
      console.warn(
        `[models] removed truncated download: ${item.name} (${item.sizeBytes} bytes on disk, expected one of ${[...sizes].join(', ')})`,
      );
    } catch (err) {
      console.warn('[models] pruneIncompleteDownloads: remove failed', item.id, err && err.message);
    }
  }
  return { removed, freedBytes };
}

// P2P assets never touch modelsRoot() until complete; partial blocks sit in
// a live, fd-locked Corestore only sdk.close() can safely release (it
// respawns lazily). Skipped while chat has a model loaded, same worker.
async function clearRegistryCorestore() {
  const chat = require('./chat.cjs');
  if (chat.isReady()) {
    console.warn('[models] clearRegistryCorestore: skipped, AI bot session active');
    return;
  }
  const registryDir = path.join(os.homedir(), '.qvac', 'registry-corestore');
  try {
    const sdk = require('@qvac/sdk');
    if (typeof sdk.close === 'function') await sdk.close();
  } catch (err) {
    console.warn('[models] clearRegistryCorestore: sdk.close failed', err && err.message);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    await fsp.rm(registryDir, { recursive: true, force: true });
  } catch (err) {
    console.warn('[models] clearRegistryCorestore: rm failed', err && err.message);
  }
}

async function removeAllModels(excludeNames) {
  const items = await listModels();
  let totalFreed = 0;
  let totalRemoved = 0;
  for (const item of items) {
    if (excludeNames?.has(item.name)) continue;
    try {
      const r = await removeModel(item.id);
      totalFreed += r.freedBytes;
      totalRemoved += r.removed;
    } catch (err) {
      console.warn('[models] failed to remove', item.id, err.message);
    }
  }
  return { removed: totalRemoved, freedBytes: totalFreed };
}

// modelId -> registry constant, for downloadModel. A few modelIds name two
// constants with different sources; skip CHAT_PRESETS's, since the AI bot
// section downloads through chat.load() instead.
const CHAT_PRESET_CONSTANTS = new Set(Object.values(CHAT_PRESETS));
let _modelIdToConstant = null;
function preferNonChatConstant(map, key, constant) {
  const existing = map.get(key);
  if (existing === undefined || (CHAT_PRESET_CONSTANTS.has(existing) && !CHAT_PRESET_CONSTANTS.has(constant))) {
    map.set(key, constant);
  }
}

function modelIdToConstant() {
  if (_modelIdToConstant === null) {
    _modelIdToConstant = new Map();
    for (const [constant, entry] of readRegistry()) {
      preferNonChatConstant(_modelIdToConstant, entry.modelId, constant);
    }
    // Companion sets live on disk as sets/<setKey>/; Download all sends that
    // hash, which is not a modelId. Map it to the owning registry constant so
    // downloadAsset still runs (it pulls the whole set).
    for (const entry of sdkRegistryModels()) {
      const setKey = entry.companionSet && entry.companionSet.setKey;
      if (!setKey || !entry.name) continue;
      preferNonChatConstant(_modelIdToConstant, setKey, entry.name);
    }
  }
  return _modelIdToConstant;
}

const downloadEvents = new EventEmitter();

let currentDownload = null;
let downloadCancelled = false;
// Last progress tick for whichever file downloadModel() is currently on;
// queueSnapshot() only surfaces it while the name still matches the queue's
// current item, so a finished item's numbers can't leak into the next one.
let lastProgress = null;

function isCancelError(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  // WorkerShutdownError fires when the whole app is quitting mid-download;
  // retrying it is pointless (the process is on its way out) and just turns
  // one clean shutdown into a scary "unhandled" log.
  return err.name === 'InferenceCancelledError' || err.name === 'WorkerShutdownError' || /cancel/i.test(msg);
}

// Caches a model without loading it, so a chapter can be pulled ahead of
// running any of its lessons. Distinct from model-fetch.cjs's ensureModels,
// an HF-direct-only pre-fetch shortcut used before loadModel.
async function downloadModel(name, sdkOverride) {
  const constant = modelIdToConstant().get(name);
  if (!constant) throw new Error(`unknown model "${name}"`);
  const sdk = sdkOverride ?? require('@qvac/sdk');
  const model = sdk[constant];
  if (!model) throw new Error(`@qvac/sdk does not export ${constant} in this build`);

  downloadCancelled = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    // Resetting this per-attempt would drop a Stop click that lands in the
    // gap between attempt 1's cleanup and attempt 2's setup.
    if (downloadCancelled) return { downloaded: false, cancelled: true };
    const op = sdk.downloadAsset({
      assetSrc: model,
      onProgress: (update) => {
        // A renderer that (re)loads mid-download (a full page navigation,
        // not an SPA transition, in this app) has no other way to recover
        // how far along the current file already is.
        lastProgress = { name, loaded: update.downloaded, total: update.total };
        downloadEvents.emit('progress', { name, loaded: update.downloaded, total: update.total });
      },
    });
    currentDownload = { requestId: op && op.requestId, sdk };
    try {
      await op;
      if (downloadCancelled) return { downloaded: false, cancelled: true };
      return { downloaded: true };
    } catch (err) {
      if (downloadCancelled || isCancelError(err)) return { downloaded: false, cancelled: true };
      // The P2P registry path can fail its first attempt on a cold corestore
      // (see clearRegistryCorestore); one retry absorbs that transient case.
      if (attempt === 2) throw err;
      console.warn('[models] downloadModel: retrying after failure', name, err && err.message);
    } finally {
      currentDownload = null;
    }
  }
}

// Aborts the in-flight downloadAsset. Safe when nothing is running.
// Plain cancel is a pause: the SDK keeps the partial in its own cache to
// resume later. Pass clearCache for a real delete (e.g. before removeAll).
async function cancelDownload(clearCache) {
  downloadCancelled = true;
  const cur = currentDownload;
  if (!cur || !cur.requestId || typeof cur.sdk?.cancel !== 'function') {
    return { cancelled: false };
  }
  try {
    await cur.sdk.cancel({ requestId: cur.requestId, ...(clearCache ? { clearCache: true } : {}) });
  } catch (err) {
    console.warn('[models] cancelDownload: sdk.cancel failed', err && err.message);
  }
  return { cancelled: true };
}

function onDownloadProgress(callback) {
  downloadEvents.on('progress', callback);
  return () => downloadEvents.off('progress', callback);
}

// One batch runs at a time, tracked here (not in the renderer) so it keeps
// going, and keeps its own state, across a Settings page unmount/remount.
let queueState = null;

function queueSnapshot() {
  if (!queueState) return { active: false, scope: null, name: null, done: 0, total: 0, error: null, progress: null };
  const { scope, name, done, total, error } = queueState;
  const progress = lastProgress && lastProgress.name === name ? { loaded: lastProgress.loaded, total: lastProgress.total } : null;
  return { active: true, scope, name, done, total, error, progress };
}

// Sequential, not parallel: keeps one progress bar meaningful per model and
// avoids competing for the same bandwidth. downloadAsset no-ops on a model
// that's already cached, so callers can pass a scope's full list as-is.
async function downloadModels(scope, names) {
  if (queueState) return { started: false };
  queueState = { scope, name: null, done: 0, total: names.length, cancelled: false, error: null };
  downloadEvents.emit('queue', queueSnapshot());
  for (let i = 0; i < names.length; i++) {
    if (queueState.cancelled) break;
    const name = names[i];
    if (!name) continue;
    queueState.name = name;
    downloadEvents.emit('queue', queueSnapshot());
    let result;
    try {
      result = await downloadModel(name);
    } catch (err) {
      queueState.error = err instanceof Error ? err.message : String(err);
      break;
    }
    if (queueState.cancelled || result?.cancelled) break;
    queueState.done = i + 1;
  }
  queueState.name = null;
  const final = { ...queueSnapshot(), active: false };
  queueState = null;
  downloadEvents.emit('queue', final);
  return { started: true };
}

// Marks the queue cancelled without touching the current downloadAsset call,
// for removeAll (which needs its own clearCache: true cancelDownload).
function stopDownloadQueue() {
  if (queueState) queueState.cancelled = true;
}

async function cancelDownloadQueue() {
  stopDownloadQueue();
  return cancelDownload();
}

function downloadQueueState() {
  return queueSnapshot();
}

function onDownloadQueueProgress(callback) {
  downloadEvents.on('queue', callback);
  return () => downloadEvents.off('queue', callback);
}

// installedSizes overrides the static hint once the real size is known,
// rather than showing an estimate for a file already sitting on disk.
// Two registry entries can share a filename (Qwen3-4B-Q4_K_M.gguf is both a
// chat preset and a lesson model), so "a file with this name exists" says
// nothing about whether chat can load it. The preset's own src does.
function chatCacheFile(displayName) {
  const key = CHAT_PRESETS[displayName];
  if (!key) return null;
  try {
    const constant = require('@qvac/sdk')[key];
    const src = typeof constant === 'string' ? constant : constant?.src;
    const match = /^registry:\/\/[^/]+\/(.+)$/.exec(src ?? '');
    if (!match) return null;
    return cacheFileName(match[1]);
  } catch {
    return null;
  }
}

function catalogueEntryFromName(name, installedSizes, installedFiles, installedByName) {
  const usage = loadUsageMap();
  const descriptions = loadDescriptionMap();
  const hints = hintsForName(name);
  const cacheFile = chatCacheFile(name);
  const consumers = consumersForModelId(name);
  const { setKeyToMembers, memberToSetKey } = companionIndex();
  const companionSetKey = memberToSetKey.get(name) ?? null;
  const installedViaSet = Boolean(companionSetKey && installedByName?.get(companionSetKey));
  return {
    name,
    id: name,
    cacheFile,
    // Chat: the file the loader opens, not the name two entries share.
    // Everything else: a complete cache entry under this display name, or a
    // companion set that already contains this file.
    installed: cacheFile
      ? Boolean(installedFiles?.get(cacheFile))
      : Boolean(installedByName?.get(name) || installedViaSet),
    sizeBytes: installedSizes?.get(name) ?? (hints.sizeBytes || expectedSizeForName(name)),
    description: descriptions[name] ?? '',
    usedIn: usage[name] ?? [],
    family: familyForName(name),
    minRamBytes: hints.minRamBytes,
    gpu: hints.gpu,
    aiBot: consumers.aiBot,
    playground: consumers.playground,
    isCompanionSet: setKeyToMembers.has(name),
    companionSetKey,
  };
}

async function catalogue() {
  const usage = loadUsageMap();
  const installed = await listModels();
  // id is the on-disk filename, which is what tells the two same-named entries apart.
  const complete = installed.filter((i) => i.complete);
  // A partial download's current byte count isn't the model's size, so only
  // complete entries can override the expected total below.
  const installedSizes = new Map(complete.map((item) => [item.name, item.sizeBytes]));
  const installedFiles = new Map(complete.map((i) => [i.id, i.sizeBytes]));
  const installedByName = new Map(complete.map((i) => [i.name, i.sizeBytes]));
  const names = new Set();
  for (const name of Object.keys(usage)) names.add(name);
  for (const name of Object.keys(CHAT_MODEL_HINTS)) names.add(name);
  for (const name of allPlaygroundModelIds()) names.add(name);
  for (const item of installed) names.add(item.name);
  return Array.from(names)
    .map((name) => catalogueEntryFromName(name, installedSizes, installedFiles, installedByName))
    .sort((a, b) => {
      // Chat models first, then everything else, alphabetical within each group.
      if (a.family !== b.family) return a.family === 'chat' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

async function forLesson(lessonKey) {
  if (!lessonKey || !lessonKey.chapter || !lessonKey.lesson) return [];
  const cat = await catalogue();
  return cat.filter((entry) =>
    (entry.usedIn ?? []).some(
      (ref) => ref.chapter === lessonKey.chapter && (ref.lessons ?? []).includes(lessonKey.lesson),
    ),
  );
}

async function recommend(lessonKey, hardware) {
  const cat = await catalogue();
  const chat = cat.filter((e) => e.family === 'chat');
  if (chat.length === 0) {
    return { pick: null, ranked: cat, reason: 'no-chat-models' };
  }

  const lessonPicks = lessonKey
    ? chat.filter((entry) =>
        (entry.usedIn ?? []).some(
          (ref) => ref.chapter === lessonKey.chapter && (ref.lessons ?? []).includes(lessonKey.lesson),
        ),
      )
    : [];

  if (lessonPicks.length > 0) {
    return {
      pick: lessonPicks[0].name,
      ranked: lessonPicks.concat(chat.filter((e) => !lessonPicks.includes(e))),
      reason: 'lesson-requires',
    };
  }

  // A model already on disk beats one that has to download, and the largest of
  // those answers best.
  const onDisk = chat.filter((e) => e.installed).sort((a, b) => b.sizeBytes - a.sizeBytes);
  if (onDisk.length > 0) {
    return {
      pick: onDisk[0].name,
      ranked: onDisk.concat(chat.filter((e) => !e.installed)),
      reason: 'largest-installed',
    };
  }

  if (!hardware) {
    return { pick: null, ranked: chat, reason: 'no-hardware-info' };
  }

  return rankByMemoryFit(chat);
}

// Ranks chat models by the SDK's own assessModelFit instead of a hand-rolled
// minRamBytes guess, so this reads the same evidence checkMemoryFit gates
// loadModel on. Falls back to the untouched catalogue order if the SDK's
// assessModelFit isn't available (e.g. running outside Electron's main
// process, where the native addon isn't loaded).
async function rankByMemoryFit(chat) {
  let sdk;
  try {
    sdk = require('@qvac/sdk');
  } catch {
    sdk = null;
  }
  if (typeof sdk?.assessModelFit !== 'function') {
    return { pick: null, ranked: chat, reason: 'no-hardware-info' };
  }

  const candidates = chat
    .map((entry) => {
      const key = CHAT_PRESETS[entry.name];
      const model = key ? sdk[key] : null;
      return model ? { entry, model } : null;
    })
    .filter(Boolean);
  if (candidates.length === 0) {
    return { pick: null, ranked: chat, reason: 'no-hardware-info' };
  }

  const { MODEL_CTX_SIZE } = require('../shared/chat-context-size.cjs');
  let assessed;
  try {
    assessed = await sdk.assessModelFit({
      models: candidates.map((c) => ({ model: c.model, workload: { kind: 'llm', contextTokens: MODEL_CTX_SIZE } })),
      execution: 'sequential',
      policy: 'interactive-v1',
    });
  } catch {
    return { pick: null, ranked: chat, reason: 'no-hardware-info' };
  }

  const verdictOrder = { 'likely-fits': 0, unknown: 1, 'likely-too-large': 2 };
  const rankedCandidates = candidates
    .map((c, i) => ({ entry: c.entry, verdict: assessed.models[i]?.verdict ?? 'unknown' }))
    .sort((a, b) => verdictOrder[a.verdict] - verdictOrder[b.verdict]);

  const assessedNames = new Set(candidates.map((c) => c.entry.name));
  const ranked = rankedCandidates
    .map(({ entry }) => entry)
    .concat(chat.filter((entry) => !assessedNames.has(entry.name)));

  const firstFit = rankedCandidates.find((r) => r.verdict === 'likely-fits');
  return { pick: firstFit ? firstFit.entry.name : null, ranked, reason: 'hardware-fits-best' };
}

module.exports = {
  listModels,
  removeModel,
  removeAllModels,
  clearRegistryCorestore,
  pruneIncompleteDownloads,
  ACTIVE_WRITE_MS,
  knownGoodSizes,
  modelsRoot,
  catalogue,
  forLesson,
  recommend,
  downloadModel,
  cancelDownload,
  onDownloadProgress,
  downloadModels,
  stopDownloadQueue,
  cancelDownloadQueue,
  downloadQueueState,
  onDownloadQueueProgress,
  hfFallbackSrc,
};
