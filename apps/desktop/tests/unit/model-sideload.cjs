'use strict';

// The cache name has to match what the SDK computes, or a sideloaded file sits
// beside the one the loader looks for and the download happens anyway.

const test = require('brittle');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  cacheFileName,
  modelsDir,
  readRegistry,
  sideloadModel,
  sourceUrl,
} = require('../../shared/model-sideload.cjs');

// Pinned against a name the app itself created while failing to download it.
test('sideload - the cache name matches the SDK generateShortHash rule', (t) => {
  const registryPath =
    'unsloth/Qwen3-4B-GGUF/resolve/9b5c4f3506ac99d74e59ecd9aa9abb05537b7f59/Qwen3-4B-Q4_K_M.gguf';
  t.is(cacheFileName(registryPath), '4bc38d670129c36f_Qwen3-4B-Q4_K_M.gguf');
});

test('sideload - the registry parses into whole entries', (t) => {
  const registry = readRegistry();
  const entry = registry.get('QWEN3_4B_Q4_K_M');
  t.ok(entry, 'the model is in the registry');
  t.is(entry.modelId, 'Qwen3-4B-Q4_K_M.gguf');
  t.is(entry.expectedSize, 2497281312);
  t.is(entry.sha256?.length, 64, 'with a checksum to verify against');
  t.ok(sourceUrl(entry).startsWith('https://huggingface.co/'), 'and a direct source');
});

test('sideload - a source the registry does not name is refused', (t) => {
  t.exception(() => sourceUrl({ registrySource: 'ipfs', registryPath: 'x/y.gguf' }), /no direct source/);
});

test('sideload - an unknown model is refused before any request', async (t) => {
  await t.exception(sideloadModel('NOT_A_MODEL', { registry: new Map() }), /unknown model/);
});

// The size check stops a partial file from passing as the model, the state
// that wedged the FLUX lessons for days.
test('sideload - a file already the expected size is left alone', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sideload-'));
  t.teardown(() => fs.rmSync(home, { recursive: true, force: true }));

  const registryPath = 'org/repo/resolve/abc/model.gguf';
  const dir = modelsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, cacheFileName(registryPath)), Buffer.alloc(9));

  const registry = new Map([
    ['FAKE', { modelId: 'model.gguf', registryPath, registrySource: 'hf', expectedSize: 9, sha256: null }],
  ]);
  const result = await sideloadModel('FAKE', { home, registry });
  t.is(result.alreadyCached, true, 'no request goes out for a file already on disk');
  t.is(result.bytes, 9);
});

test('sideload - a short file is not counted as cached', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sideload-'));
  t.teardown(() => fs.rmSync(home, { recursive: true, force: true }));

  const registryPath = 'org/repo/resolve/abc/model.gguf';
  const dir = modelsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, cacheFileName(registryPath)), Buffer.alloc(8));

  const registry = new Map([
    ['FAKE', { modelId: 'model.gguf', registryPath, registrySource: 'nowhere', expectedSize: 9, sha256: null }],
  ]);
  // Reaching sourceUrl proves the short file did not satisfy the cache check.
  await t.exception(sideloadModel('FAKE', { home, registry }), /no direct source/);
});

test('sideload - the checksum in the registry is the one to verify against', (t) => {
  const entry = readRegistry().get('QWEN3_4B_Q4_K_M');
  const digest = crypto.createHash('sha256').update(Buffer.from('not the model', 'utf8')).digest('hex');
  t.not(digest, entry.sha256, 'an arbitrary payload cannot match it');
});
