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
  pruneTruncatedModels,
  findTruncatedModels,
  cacheBytes,
} = require('../../shared/model-integrity.cjs');
const { tmpDir } = require('../helpers/index.cjs');

function writeModel(root, rel, bytes) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  return abs;
}

// path.join, not a forward-slash literal: scan() keys its manifest with
// path.join too, so a hardcoded "/" wouldn't match a Windows lookup.
const SHARDED_REL = path.join('sharded', 'keyhex', 'shard-0');

function fixture(t, name) {
  const stateDir = tmpDir(t, `${name}-state`);
  const root = tmpDir(t, `${name}-models`);
  writeModel(root, 'aaaa_model.gguf', Buffer.alloc(64, 1));
  writeModel(root, SHARDED_REL, Buffer.alloc(32, 2));
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

// Without a re-baseline, one divergence would flag the same file on every future scan forever.
test('model-integrity - a reported change does not repeat on the next scan', (t) => {
  const { stateDir, root } = fixture(t, 'mi-rewrite-once');
  syncFast(stateDir, root);

  const abs = path.join(root, 'aaaa_model.gguf');
  fs.writeFileSync(abs, Buffer.alloc(64, 9));
  const future = Date.now() / 1000 + 120;
  fs.utimesSync(abs, future, future);

  t.alike(syncFast(stateDir, root).changed, ['aaaa_model.gguf'], 'reported once');
  t.alike(syncFast(stateDir, root).changed, [], 'not reported again');
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
  t.is(readManifest(stateDir).files[SHARDED_REL].sha256, null,
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

// Stop has no child to signal during this pre-spawn check, so isCancelled is its only way in.
test('model-integrity - verifyModelsAsync gives up early once cancelled', async (t) => {
  const { stateDir, root } = fixture(t, 'mi-verify-cancel');
  writeModel(root, CACHED, Buffer.alloc(64, 1));

  const result = await verifyModelsAsync(['model.gguf'], stateDir, root, () => true);
  t.alike(result, { verified: [], mismatched: [], recorded: [] }, 'cancelled before reading anything');
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

// A run killed mid-download leaves a truncated file at the model's real
// name; Llama-3.2-1B-Instruct-Q4_0.gguf is a real @qvac/sdk registry entry
// (expectedSize 773025824), so this exercises the real lookup, not a stub.
test('model-integrity - prunes a truncated model, leaves a complete one alone', (t) => {
  const { root } = fixture(t, 'mi-truncated');
  // CACHE_HASH_PREFIX needs exactly 16 hex chars, unlike this file's other
  // fixtures' short fake prefixes, to actually exercise the strip.
  const truncated = writeModel(root, 'aaaaaaaaaaaaaaaa_Llama-3.2-1B-Instruct-Q4_0.gguf', Buffer.alloc(1024));
  // A sparse file: the right *size* to pass the check without writing 773 MB of real bytes.
  const complete = writeModel(root, 'bbbbbbbbbbbbbbbb_Llama-3.2-1B-Instruct-Q4_0.gguf', Buffer.alloc(0));
  fs.truncateSync(complete, 773025824);
  const unknown = writeModel(root, 'cccccccccccccccc_not-a-real-model.gguf', Buffer.alloc(10));

  t.alike(findTruncatedModels(root), ['aaaaaaaaaaaaaaaa_Llama-3.2-1B-Instruct-Q4_0.gguf'],
    'reported before anything is removed');

  const removed = pruneTruncatedModels(root);
  t.alike(removed.sort(), ['aaaaaaaaaaaaaaaa_Llama-3.2-1B-Instruct-Q4_0.gguf']);
  t.absent(fs.existsSync(truncated), 'the truncated file is gone');
  t.ok(fs.existsSync(complete), 'the correctly-sized file survives');
  t.ok(fs.existsSync(unknown), 'a name with no registry entry is left alone');
});

// The peer host keeps a run alive for as long as this number moves.
test('model-integrity - cacheBytes tracks a growing download', (t) => {
  const { root } = fixture(t, 'mi-cache-bytes');
  const before = cacheBytes(root);
  t.ok(before > 0, 'counts what is already cached');

  writeModel(root, 'dddddddddddddddd_partial.gguf', Buffer.alloc(4096));
  t.is(cacheBytes(root), before + 4096, 'grows by what the transfer wrote');
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
