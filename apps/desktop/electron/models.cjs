// Lists, sizes, and removes downloaded QVAC models on disk.
//
// QVAC stores cached models under `<HOME>/.qvac/models/` in three layouts:
//   - single:  `<shortHash>_<originalFile>`            (most common)
//   - sharded: `sharded/<hyperdriveKey>/<shardFile>`   (split weights)
//   - set:     `sets/<setKey>/<targetName>`            (companion set)
//
// The renderer only needs (id, name, sizeBytes, kind). We group the sharded
// and set layouts into one row per directory so removing a row never leaves
// a half-deleted model behind.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const SINGLE_HASH_RE = /^([0-9a-f]{16})_(.+)$/;

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

// Strip the SDK's hash prefix from a single-file cache entry so the user sees
// "Qwen3-0.6B-Q4_0.gguf" instead of "5b8aae816570a09d_Qwen3-0.6B-Q4_0.gguf".
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
      out.push({
        id: entry.name,
        name: displayName,
        sizeBytes: s.size,
        kind: 'single',
        sourceHash: hashMatch ? hashMatch[1] : '',
        fileCount: 1,
        usedIn: usage[displayName] ?? [],
        description: descriptions[displayName] ?? '',
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

module.exports = { listModels, removeModel, removeAllModels, modelsRoot };
