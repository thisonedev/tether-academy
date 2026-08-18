const path = require('node:path');
const fs = require('node:fs');
const { diagnoseNativeAddonError } = require('../shared/linux-lib-hint.cjs');

// Lazy so a missing native dep (e.g. rocksdb-native needs libatomic.so.1)
// throws from createStore(), where it's catchable, instead of crashing the
// whole process at require time with no chance to add a hint.
function loadCorestore() {
  try {
    return require('corestore');
  } catch (err) {
    const hint = diagnoseNativeAddonError(err);
    if (hint) err.message = `${err.message}\n${hint}`;
    throw err;
  }
}

// Key-value state only; device identity lives in identity/manager.cjs.
//
// Compaction: every SNAPSHOT_THRESHOLD set/remove ops, a snapshot op carrying
// the full cache is appended and prior blocks are cleared with core.clear().
// Replay reads with wait: false, since the default wait: true would hang
// forever on a cleared index on this peerless core instead of returning null.

const SNAPSHOT_THRESHOLD = 64;

/**
 * @param {string} userDataDir
 */
async function createStore(userDataDir) {
  const Corestore = loadCorestore();
  const dir = path.join(userDataDir, 'corestore');
  fs.mkdirSync(dir, { recursive: true });
  const store = new Corestore(dir);

  const cache = await loadOrMigrateState(store, userDataDir);
  // Compaction runs on a fixed op budget rather than a timer.
  let opsSinceSnapshot = 0;

  const stateCore = store.get({ name: 'kv-state', valueEncoding: 'json' });
  await stateCore.ready();

  async function compact() {
    // Snapshot is appended before the clear, so a crash between the two
    // still leaves replay landing on the snapshot with stale ops discarded.
    const snapshot = { ...cache };
    await stateCore.append({ op: 'snapshot', state: snapshot, ts: Date.now() });
    const snapshotIndex = stateCore.length - 1;
    if (snapshotIndex > 0) {
      await stateCore.clear(0, snapshotIndex);
    }
    opsSinceSnapshot = 0;
  }

  return {
    async get(key) {
      return Object.hasOwn(cache, key) ? cache[key] : null;
    },

    async set(key, value) {
      cache[key] = value;
      await stateCore.append({ op: 'set', key, value, ts: Date.now() });
      opsSinceSnapshot += 1;
      if (opsSinceSnapshot >= SNAPSHOT_THRESHOLD) {
        try { await compact(); } catch { /* leave the log; next op will retry */ }
      }
    },

    async remove(key) {
      if (!Object.hasOwn(cache, key)) return;
      delete cache[key];
      await stateCore.append({ op: 'remove', key, ts: Date.now() });
      opsSinceSnapshot += 1;
      if (opsSinceSnapshot >= SNAPSHOT_THRESHOLD) {
        try { await compact(); } catch { /* leave the log; next op will retry */ }
      }
    },

    async list() {
      return Object.entries(cache).map(([key, value]) => ({ key, value }));
    },

    async close() {
      await store.close();
    },
  };
}

async function loadOrMigrateState(store, userDataDir) {
  const core = store.get({ name: 'kv-state', valueEncoding: 'json' });
  await core.ready();

  const cache = {};
  const len = core.length;
  for (let i = 0; i < len; i++) {
    // null means the block was cleared; guard before reading evt.op.
    const evt = await core.get(i, { wait: false });
    if (evt === null) continue;
    if (evt.op === 'set') cache[evt.key] = evt.value;
    else if (evt.op === 'remove') delete cache[evt.key];
    // snapshot replaces the accumulator; earlier ops are stale and dropped.
    else if (evt.op === 'snapshot') Object.assign(cache, evt.state);
  }

  if (len === 0) {
    const legacyPath = path.join(userDataDir, 'state.json');
    if (fs.existsSync(legacyPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
        const entries = Object.entries(data ?? {});
        if (entries.length > 0) {
          const ts = Date.now();
          for (const [key, value] of entries) {
            await core.append({ op: 'set', key, value, ts });
            cache[key] = value;
          }
          fs.unlinkSync(legacyPath);
          console.log(
            `[state-store] migrated ${entries.length} key(s) from state.json into kv-state core`,
          );
        }
      } catch (err) {
        console.warn('[state-store] state.json migration failed:', err.message);
      }
    }
  }

  return cache;
}

module.exports = { createStore, SNAPSHOT_THRESHOLD };