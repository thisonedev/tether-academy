// Lists, sizes, and removes downloaded QVAC models. Models live under
// `<HOME>/.qvac/models/` as single files, `sharded/<key>/`, or `sets/<key>/`;

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

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
        if (count === 0) continue;
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
          complete: true,
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

// Memoized filename -> set of valid download sizes, from @qvac/sdk's registry
// (multiple entries when a file has more than one legitimate source).
let _knownSizesByName = null;
function knownGoodSizes(filename) {
  if (_knownSizesByName === null) {
    _knownSizesByName = new Map();
    try {
      const { models: registryModels } = require('@qvac/sdk/models');
      for (const entry of registryModels) {
        if (!entry.modelId || !entry.expectedSize) continue;
        const sizes = _knownSizesByName.get(entry.modelId) ?? new Set();
        sizes.add(entry.expectedSize);
        _knownSizesByName.set(entry.modelId, sizes);
      }
    } catch (err) {
      console.warn('[models] knownGoodSizes: could not load @qvac/sdk registry', err && err.message);
    }
  }
  return _knownSizesByName.get(filename) ?? null;
}

async function pruneIncompleteDownloads() {
  const items = await listModels();
  const removed = [];
  let freedBytes = 0;
  for (const item of items) {
    if (item.kind !== 'single') continue;
    const sizes = knownGoodSizes(item.name);
    if (!sizes || sizes.has(item.sizeBytes)) continue;
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

async function removeAllModels() {
  const items = await listModels();
  let totalFreed = 0;
  let totalRemoved = 0;
  for (const item of items) {
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

function catalogueEntryFromName(name) {
  const usage = loadUsageMap();
  const descriptions = loadDescriptionMap();
  const hints = hintsForName(name);
  return {
    name,
    id: name,
    sizeBytes: hints.sizeBytes,
    description: descriptions[name] ?? '',
    usedIn: usage[name] ?? [],
    family: familyForName(name),
    minRamBytes: hints.minRamBytes,
    gpu: hints.gpu,
  };
}

async function catalogue() {
  const usage = loadUsageMap();
  const installed = await listModels();
  const names = new Set();
  for (const name of Object.keys(usage)) names.add(name);
  for (const name of Object.keys(CHAT_MODEL_HINTS)) names.add(name);
  for (const item of installed) names.add(item.name);
  return Array.from(names)
    .map(catalogueEntryFromName)
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

  if (!hardware) {
    return { pick: null, ranked: chat, reason: 'no-hardware-info' };
  }

  const headroom = 2 * 1024 ** 3;
  const ranked = chat
    .map((entry) => {
      const required = entry.minRamBytes > 0 ? entry.minRamBytes + headroom : 0;
      if (required === 0) return { entry, fit: 'fits' };
      if (hardware.memoryBytes >= required * 1.5) return { entry, fit: 'fits' };
      if (hardware.memoryBytes >= required) return { entry, fit: 'tight' };
      return { entry, fit: 'too-big' };
    })
    .sort((a, b) => {
      const order = { fits: 0, tight: 1, 'too-big': 2 };
      return order[a.fit] - order[b.fit] || a.entry.minRamBytes - b.entry.minRamBytes;
    })
    .map(({ entry }) => entry);

  const firstFit = ranked.find((e) => e.minRamBytes === 0 || hardware.memoryBytes >= e.minRamBytes + headroom);
  return { pick: firstFit ? firstFit.name : null, ranked, reason: 'hardware-fits-best' };
}

module.exports = {
  listModels,
  removeModel,
  removeAllModels,
  pruneIncompleteDownloads,
  knownGoodSizes,
  modelsRoot,
  catalogue,
  forLesson,
  recommend,
};
