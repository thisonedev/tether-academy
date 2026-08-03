'use strict';

// Compaction of the append-only KV state log. A run that rewrites one key
// once a second grows the log forever; a snapshot op + clear() range keeps
// it bounded. Replay must read [wait: false] so a cleared block returns
// null instead of hanging forever on a local-only core.

const test = require('brittle');
const fs = require('node:fs');
const path = require('node:path');

const { createStore, SNAPSHOT_THRESHOLD } = require('../../electron/state-store.cjs');
const { tmpDir } = require('../helpers/index.cjs');

test('state-store - set/get/remove/list round trip', async (t) => {
  const dir = tmpDir(t, 'kv-roundtrip');
  const store = await createStore(dir);
  t.is(await store.get('a'), null);
  await store.set('a', 1);
  await store.set('b', 'two');
  t.is(await store.get('a'), 1);
  t.is(await store.get('b'), 'two');
  await store.remove('a');
  t.is(await store.get('a'), null);
  const list = await store.list();
  t.is(list.length, 1);
  t.alike(list[0], { key: 'b', value: 'two' });
  await store.close();
});

test('state-store - compaction appends a snapshot and clears prior blocks', async (t) => {
  const dir = tmpDir(t, 'kv-compact');
  const store = await createStore(dir);
  // One set per call; SNAPSHOT_THRESHOLD triggers a snapshot+clear.
  for (let i = 0; i < SNAPSHOT_THRESHOLD; i++) {
    await store.set(`k${i}`, i);
  }
  await store.close();

  // Reopen a fresh corestore on the same dir; only one corestore holds the
  // directory at a time, so close-then-reopen is required.
  const Corestore = require('corestore');
  const cs = new Corestore(path.join(dir, 'corestore'));
  const rawCore = cs.get({ name: 'kv-state', valueEncoding: 'json' });
  await rawCore.ready();
  // core.length does NOT shrink on clear(); check the per-block flag instead.
  const tail = await rawCore.get(rawCore.length - 1, { wait: false });
  t.ok(tail && tail.op === 'snapshot', 'tail is a snapshot');
  t.alike(tail.state, Object.fromEntries(
    Array.from({ length: SNAPSHOT_THRESHOLD }, (_, i) => [`k${i}`, i]),
  ));
  // Pre-snapshot blocks have been cleared and return null.
  const head = await rawCore.get(0, { wait: false });
  t.is(head, null, 'pre-snapshot blocks are gone');
  await cs.close();
});

test('state-store - reopened store replays from snapshot', async (t) => {
  const dir = tmpDir(t, 'kv-reopen');
  let store = await createStore(dir);
  for (let i = 0; i < SNAPSHOT_THRESHOLD + 5; i++) {
    await store.set(`k${i}`, i);
  }
  await store.close();

  store = await createStore(dir);
  // The post-snapshot writes are also in the log; reopen must apply them all.
  t.is(await store.get(`k${SNAPSHOT_THRESHOLD + 4}`), SNAPSHOT_THRESHOLD + 4);
  t.is(await store.get('k0'), 0);
  const list = await store.list();
  t.is(list.length, SNAPSHOT_THRESHOLD + 5);
  await store.close();
});

test('state-store - snapshot reached without clear replays correctly', async (t) => {
  const dir = tmpDir(t, 'kv-snapshot-only');
  // Drive the threshold exactly so a snapshot is appended; pre-snapshot
  // blocks still exist because we will inspect the core without clear().
  const store = await createStore(dir);
  for (let i = 0; i < SNAPSHOT_THRESHOLD; i++) {
    await store.set(`k${i}`, i);
  }
  await store.close();

  const Corestore = require('corestore');
  const cs = new Corestore(path.join(dir, 'corestore'));
  const rawCore = cs.get({ name: 'kv-state', valueEncoding: 'json' });
  await rawCore.ready();
  // snapshotIndex is the tail; pre-snapshot blocks remain.
  const snapshotIndex = rawCore.length - 1;
  const tail = await rawCore.get(snapshotIndex, { wait: false });
  t.ok(tail && tail.op === 'snapshot', 'snapshot appended');
  await cs.close();

  // Reopen: the snapshot replaces the accumulator, so earlier set entries
  // do not double-apply. Without the snapshot branch, an entry written
  // before the snapshot would clobber it.
  const store2 = await createStore(dir);
  t.alike(await store2.list(),
    Array.from({ length: SNAPSHOT_THRESHOLD }, (_, i) => ({ key: `k${i}`, value: i })),
  );
  await store2.close();
});

test('state-store - reopen after a clear completes without hanging', async (t) => {
  // The regression this guards is a hang, not a wrong value. The test runs
  // against a real corestore with no peers; if the replay loop calls
  // core.get(i) without { wait: false }, it blocks forever instead of
  // returning null and the test timeout would fire.
  const dir = tmpDir(t, 'kv-clear-hang');
  const Corestore = require('corestore');
  const corestore = new Corestore(path.join(dir, 'corestore'));
  const core = corestore.get({ name: 'kv-state', valueEncoding: 'json' });
  await core.ready();
  await core.append({ op: 'set', key: 'a', value: 1 });
  await core.append({ op: 'set', key: 'b', value: 2 });
  await core.clear(0, core.length);
  await corestore.close();

  const store = await createStore(dir);
  t.is(await store.get('a'), null, 'cleared key returns null');
  t.is(await store.get('b'), null, 'cleared key returns null');
  t.alike(await store.list(), []);
  await store.close();
});