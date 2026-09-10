'use strict';

// The blob transfer has stalled outright on files whose origin serves them in
// a minute, and nothing in the SDK gives up, so every path that loads a model
// tries the registry's named source first.

const test = require('brittle');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureModels, isPresent, checkDiskSpace, ACTIVE_WRITE_MS } = require('../../shared/model-fetch.cjs');
const { cacheFileName, modelsDir } = require('../../shared/model-sideload.cjs');

// Sparse, so a multi-gigabyte model costs nothing to stand in for.
function plant(home, registryPath, bytes) {
  const dir = modelsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(path.join(dir, cacheFileName(registryPath)), 'w');
  fs.ftruncateSync(fd, bytes);
  fs.closeSync(fd);
}

test('model-fetch - a file already at its full size is left alone', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-'));
  t.teardown(() => fs.rmSync(home, { recursive: true, force: true }));
  const registryPath = 'org/repo/resolve/abc/model.gguf';
  plant(home, registryPath, 12);
  const later = Date.now() + ACTIVE_WRITE_MS + 1;
  t.is(isPresent({ registryPath, expectedSize: 12 }, home, later), true);
  t.is(isPresent({ registryPath, expectedSize: 13 }, home, later), false, 'a short file is not');
});

// Fetching over a file another writer holds open is how a download ends up at
// a path with nothing in it, so a short file being written is left alone.
test('model-fetch - a file being written right now is not touched', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-'));
  t.teardown(() => fs.rmSync(home, { recursive: true, force: true }));
  const registryPath = 'org/repo/resolve/abc/model.gguf';
  plant(home, registryPath, 12);
  t.is(isPresent({ registryPath, expectedSize: 999 }, home), true, 'short but active');
});

test('model-fetch - nothing to do for models already on disk', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-'));
  t.teardown(() => fs.rmSync(home, { recursive: true, force: true }));
  // A real entry, so the registry lookup resolves, with the file planted.
  const { readRegistry } = require('../../shared/model-sideload.cjs');
  const entry = readRegistry().get('QWEN3_4B_Q4_K_M');
  plant(home, entry.registryPath, entry.expectedSize);

  const result = await ensureModels(['QWEN3_4B_Q4_K_M'], { home });
  t.alike(result.present, ['QWEN3_4B_Q4_K_M']);
  t.alike(result.fetched, [], 'no request went out');
});

// 567 of the registry's entries have no URL to fetch from, so those runs still
// depend on the blob transfer and must not be reported as failures here.
test('model-fetch - a model with no direct source is left to the SDK', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-'));
  t.teardown(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = await ensureModels(['QWEN3_4B_INST_Q4_K_M'], { home });
  t.alike(result.unavailable, ['QWEN3_4B_INST_Q4_K_M'], 's3 entries are skipped');
  t.alike(result.failed, [], 'skipping is not failing');
});

test('model-fetch - an unknown name is ignored rather than thrown', async (t) => {
  const result = await ensureModels(['NOT_A_REAL_MODEL'], { home: os.tmpdir() });
  t.alike(result.fetched, []);
  t.alike(result.failed, []);
});

// The peer worker's FETCH_MODELS handler calls this shortcut directly with
// no checkDiskSpace of its own, so ensureModels has to refuse on its own.
test('model-fetch - ensureModels skips a fetch that would not fit on disk', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-'));
  t.teardown(() => fs.rmSync(home, { recursive: true, force: true }));
  const { readRegistry } = require('../../shared/model-sideload.cjs');
  const entry = readRegistry().get('QWEN3_4B_Q4_K_M');

  const result = await ensureModels(['QWEN3_4B_Q4_K_M'], {
    home,
    freeBytesOverride: entry.expectedSize - 1,
  });
  t.alike(result.fetched, [], 'never attempted');
  t.alike(result.failed, ['QWEN3_4B_Q4_K_M']);
});

test('model-fetch - checkDiskSpace blocks a download that would not fit', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-'));
  t.teardown(() => fs.rmSync(home, { recursive: true, force: true }));
  const { readRegistry } = require('../../shared/model-sideload.cjs');
  const entry = readRegistry().get('QWEN3_4B_Q4_K_M');

  const result = await checkDiskSpace(['QWEN3_4B_Q4_K_M'], home, entry.expectedSize - 1);
  t.is(result.ok, false);
  t.is(result.name, 'QWEN3_4B_Q4_K_M');
  t.ok(/not enough disk space/.test(result.message));
});

test('model-fetch - checkDiskSpace allows a download that fits', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-'));
  t.teardown(() => fs.rmSync(home, { recursive: true, force: true }));
  const { readRegistry } = require('../../shared/model-sideload.cjs');
  const entry = readRegistry().get('QWEN3_4B_Q4_K_M');

  const result = await checkDiskSpace(['QWEN3_4B_Q4_K_M'], home, entry.expectedSize + 1);
  t.is(result.ok, true);
});

// Two candidates that individually fit but not together must not both pass:
// the second one has to be checked against what the first already claimed.
test('model-fetch - checkDiskSpace charges earlier names against the same free space', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-'));
  t.teardown(() => fs.rmSync(home, { recursive: true, force: true }));
  const { readRegistry } = require('../../shared/model-sideload.cjs');
  const entry = readRegistry().get('QWEN3_4B_Q4_K_M');

  const result = await checkDiskSpace(
    ['QWEN3_4B_Q4_K_M', 'QWEN3_4B_Q4_K_M'],
    home,
    entry.expectedSize + 1,
  );
  t.is(result.ok, false, 'the second copy no longer fits in what is left');
});

test('model-fetch - checkDiskSpace skips a model already complete on disk', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-'));
  t.teardown(() => fs.rmSync(home, { recursive: true, force: true }));
  const { readRegistry } = require('../../shared/model-sideload.cjs');
  const entry = readRegistry().get('QWEN3_4B_Q4_K_M');
  plant(home, entry.registryPath, entry.expectedSize);

  const result = await checkDiskSpace(['QWEN3_4B_Q4_K_M'], home, 0);
  t.is(result.ok, true, 'nothing left to download, so zero free space is fine');
});

// exec-host runs under Bare, which has no https. Requiring it at module load
// took the peer worker down with MODULE_NOT_FOUND on every start.
test('model-fetch - the module loads without https available', (t) => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'shared', 'model-sideload.cjs'),
    'utf8',
  );
  const top = src.slice(0, src.indexOf('function get('));
  t.absent(/^const https = require/m.test(top), 'https is not required at module scope');
  t.ok(/require\('https'\)/.test(src), 'it is required where the request happens');
});
