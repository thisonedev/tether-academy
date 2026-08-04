'use strict';

// Covers what the pre-run integrity check has to get right: notice a rewrite, stay quiet on a re-scan, and never flag the app's own downloads.

const test = require('brittle');
const fs = require('node:fs');
const path = require('node:path');

const {
  syncFast,
  acceptAll,
  verifyAll,
  verifyModels,
  verifyModelsAsync,
  sha256FileAsync,
  scheduleVerifyAll,
  readManifest,
} = require('../../shared/model-integrity.cjs');
const { tmpDir } = require('../helpers/index.cjs');

function writeModel(root, rel, bytes) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  return abs;
}

function fixture(t, name) {
  const stateDir = tmpDir(t, `${name}-state`);
  const root = tmpDir(t, `${name}-models`);
  writeModel(root, 'aaaa_model.gguf', Buffer.alloc(64, 1));
  writeModel(root, 'sharded/keyhex/shard-0', Buffer.alloc(32, 2));
  return { stateDir, root };
}

test('model-integrity - a first scan records, and reports nothing changed', (t) => {
  const { stateDir, root } = fixture(t, 'mi-first');

  const first = syncFast(stateDir, root);
  t.is(first.added.length, 2);
  t.is(first.changed.length, 0);

  t.alike(syncFast(stateDir, root), { changed: [], added: [] }, 'a re-scan is quiet');
});

test('model-integrity - a rewritten file is reported', (t) => {
  const { stateDir, root } = fixture(t, 'mi-rewrite');
  syncFast(stateDir, root);

  const abs = path.join(root, 'aaaa_model.gguf');
  fs.writeFileSync(abs, Buffer.alloc(64, 9));
  const future = Date.now() / 1000 + 120;
  fs.utimesSync(abs, future, future);

  t.alike(syncFast(stateDir, root).changed, ['aaaa_model.gguf']);
});

// If a download from the app's own runs read as tampering, every peer-exec after it would be refused.
test('model-integrity - accepting re-baselines what a local run downloaded', (t) => {
  const { stateDir, root } = fixture(t, 'mi-accept');
  syncFast(stateDir, root);

  writeModel(root, 'bbbb_new.gguf', Buffer.alloc(16, 3));
  const abs = path.join(root, 'aaaa_model.gguf');
  fs.writeFileSync(abs, Buffer.alloc(128, 9));
  const future = Date.now() / 1000 + 120;
  fs.utimesSync(abs, future, future);

  acceptAll(stateDir, root);
  t.alike(syncFast(stateDir, root), { changed: [], added: [] });
});

test('model-integrity - a removed model leaves no record behind', (t) => {
  const { stateDir, root } = fixture(t, 'mi-remove');
  syncFast(stateDir, root);

  fs.rmSync(path.join(root, 'sharded'), { recursive: true, force: true });
  syncFast(stateDir, root);

  t.alike(Object.keys(readManifest(stateDir).files), ['aaaa_model.gguf']);
});

// A rewrite that restores size and mtime needs the hash, which is why one is recorded at all.
test('model-integrity - verify catches a rewrite the stat check misses', (t) => {
  const { stateDir, root } = fixture(t, 'mi-verify');
  const abs = path.join(root, 'aaaa_model.gguf');
  const { atimeMs, mtimeMs } = fs.statSync(abs);

  syncFast(stateDir, root);
  t.is(verifyAll(stateDir, root).recorded.length, 2, 'hashes recorded on first verify');

  fs.writeFileSync(abs, Buffer.alloc(64, 9));
  fs.utimesSync(abs, atimeMs / 1000, mtimeMs / 1000);

  t.alike(syncFast(stateDir, root).changed, [], 'same size, same mtime');
  t.alike(verifyAll(stateDir, root).mismatched, ['aaaa_model.gguf'], 'different bytes');
});

// verifyAll reads the whole cache and is user-invoked; verifyModels reads only what the run named, which makes a content
// check affordable on the exec path. The SDK prefixes a cache entry with 16 hex chars of its content hash.
const CACHED = '0123456789abcdef_model.gguf';

test('model-integrity - verifyModels catches the same rewrite, reading one file', (t) => {
  const { stateDir, root } = fixture(t, 'mi-verify-models');
  const abs = writeModel(root, CACHED, Buffer.alloc(64, 1));
  const { atimeMs, mtimeMs } = fs.statSync(abs);

  syncFast(stateDir, root);
  t.alike(verifyModels(['model.gguf'], stateDir, root).recorded, [CACHED],
    'first sight is what the hash gets recorded from');

  fs.writeFileSync(abs, Buffer.alloc(64, 9));
  fs.utimesSync(abs, atimeMs / 1000, mtimeMs / 1000);

  t.alike(syncFast(stateDir, root).changed, [], 'same size, same mtime');
  const result = verifyModels(['model.gguf'], stateDir, root);
  t.alike(result.mismatched, [CACHED], 'the hash still catches it');
  t.alike(result.verified, [], 'and does not call it verified');
});

test('model-integrity - verifyModels reads nothing the run did not name', (t) => {
  const { stateDir, root } = fixture(t, 'mi-verify-scoped');
  writeModel(root, CACHED, Buffer.alloc(64, 1));
  syncFast(stateDir, root);

  t.alike(verifyModels(['model.gguf'], stateDir, root).recorded, [CACHED],
    'only the named model is hashed');
  t.is(readManifest(stateDir).files['sharded/keyhex/shard-0'].sha256, null,
    'the rest of the cache is untouched');

  t.alike(verifyModels([], stateDir, root).recorded, [], 'a run naming no model reads nothing');
  t.alike(verifyModels(['absent.gguf'], stateDir, root).mismatched, [], 'nor does an absent one');
});

// The peer worker gates a run on verifyModelsAsync, so its result shape and rewrite detection must match the sync version.
test('model-integrity - verifyModelsAsync catches the same rewrite', async (t) => {
  const { stateDir, root } = fixture(t, 'mi-verify-async');
  const abs = writeModel(root, CACHED, Buffer.alloc(64, 1));
  const { atimeMs, mtimeMs } = fs.statSync(abs);

  syncFast(stateDir, root);
  await verifyModelsAsync(['model.gguf'], stateDir, root);

  fs.writeFileSync(abs, Buffer.alloc(64, 9));
  fs.utimesSync(abs, atimeMs / 1000, mtimeMs / 1000);

  t.alike(syncFast(stateDir, root).changed, [], 'same size, same mtime');
  const result = await verifyModelsAsync(['model.gguf'], stateDir, root);
  t.alike(result.mismatched, [CACHED], 'hash catches the rewrite');
  t.alike(result.verified, [], 'and does not call it verified');
});

test('model-integrity - sha256FileAsync matches sha256File', async (t) => {
  const abs = writeModel(
    tmpDir(t, 'mi-sha'),
    'sample.bin',
    Buffer.from('hello world'),
  );
  const expected = require('crypto')
    .createHash('sha256')
    .update('hello world')
    .digest('hex');
  t.is(await sha256FileAsync(abs), expected);
  t.is(
    require('../../shared/model-integrity.cjs').sha256File(abs),
    expected,
    'sync and async produce the same hash',
  );
});

// Main warms the manifest via scheduleVerifyAll so most files already have hashes before the worker's run-time check asks.
test('model-integrity - scheduleVerifyAll runs verifyAll in the background', async (t) => {
  const { stateDir, root } = fixture(t, 'mi-schedule');
  t.is(Object.keys(readManifest(stateDir).files).length, 0);

  const result = await scheduleVerifyAll(stateDir, root);
  t.ok(result, 'schedule returns the verifyAll result');
  t.ok(result.verified.length + result.recorded.length > 0);
  t.ok(
    Object.keys(readManifest(stateDir).files).length > 0,
    'manifest was filled in',
  );
});
