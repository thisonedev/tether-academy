const path = require('node:path');
const fs = require('node:fs');
const Corestore = require('corestore');

// Key-value state only. The device identity lives in identity/manager.cjs;
// this file used to keep a second ed25519 keypair of its own, which is one
// identity implementation more than the trust model has room for.
//
// Compaction: every SNAPSHOT_THRESHOLD set/remove ops, a snapshot op is
// appended carrying the full cache, then the prior blocks are cleared with
// core.clear(). Replay reads [wait: false] on every index because the local
// core has no peers and core.get() defaults to wait: true, which would hang
// forever on a cleared index instead of returning null.

const SNAPSHOT_THRESHOLD = 64;

/**
 * @param {string} userDataDir
 */
async function createStore(userDataDir) {
  const dir = path.join(userDataDir, 'corestore');
  fs.mkdirSync(dir, { recursive: true });
  const store = new Corestore(dir);

  const cache = await loadOrMigrateState(store, userDataDir);
  // Keeps a count of ops appended since the last snapshot, so compaction
  // runs on a fixed budget rather than a timer.
  let opsSinceSnapshot = 0;

  const stateCore = store.get({ name: 'kv-state', valueEncoding: 'json' });
  await stateCore.ready();

  async function compact() {
    // Append the snapshot first, then clear everything before it. If the
    // process dies between the append and the clear, replay reaches the
    // snapshot and discards the stale early ops anyway.
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
    // wait: false returns null when the block is gone (cleared), so a
    // local-only core never hangs on a deleted index. The catch above is
    // why the loop must guard evt before reading op.
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