// Regression: SDK upgrades that change the bundled descriptor's registryPath
// leave stale `<oldHash>_<filename>` copies on disk. Host dedupes at
// ensureLoaded time so the picker shows one row per installed chat model.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const test = require('brittle');

// Sandbox the models root by rebinding os.homedir() to point at a tmp dir.
// chat.cjs and models.cjs both call os.homedir() at lookup time.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-dedupe-test-'));
const stubbedHome = path.join(tmpRoot, 'fakehome');
const realHomedir = os.homedir;
os.homedir = function stubbedHomedir() { return stubbedHome; };

function writeFakeModelFile(name, content, mtimeMs) {
  // Match the SDK's on-disk naming: 16-hex prefix + filename.
  const hash = require('node:crypto').createHash('sha1').update(name + ':' + content + ':' + mtimeMs).digest('hex').slice(0, 16);
  const dir = path.join(stubbedHome, '.qvac', 'models');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${hash}_${name}`);
  fs.writeFileSync(file, content);
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

const chatPath = require.resolve('../../electron/chat.cjs');
const sdkPath = require.resolve('@qvac/sdk');

function freshChat(loadModelImpl) {
  delete require.cache[sdkPath];
  delete require.cache[chatPath];
  const stub = {
    QWEN3_4B_INST_Q4_K_M: { name: 'Qwen3-4B-Q4_K_M' },
    QWEN3_1_7B_INST_Q4: { name: 'Qwen3-1.7B-Q4_0' },
    QWEN3_600M_INST_Q4: { name: 'Qwen3-0.6B-Q4_0' },
    QWEN3_8B_INST_Q4_K_M: { name: 'Qwen3-8B-Q4_K_M' },
    LLAMA_3_2_1B_INST_Q4_0: { name: 'Llama-3.2-1B-Instruct-Q4_0' },
    loadModel: async () => loadModelImpl(),
    unloadModel: async () => undefined,
    // adoptLoadedFromSdk must return null so the test exercises the
    // loadModel code path. Earlier this called getLoadedModelInfo({}) and
    // threw, so it already returns null in practice.
    getLoadedModelInfo: async () => { throw new Error('not configured in this test'); },
  };
  require.cache[sdkPath] = { exports: stub, id: sdkPath, filename: sdkPath, loaded: true, children: [], paths: [] };
  return require(chatPath);
}

test('chat-dedupe - removes older files with the same name after a fresh loadModel', async (t) => {
  const dir = path.join(stubbedHome, '.qvac', 'models');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // Two files with the same display name but different sourceHash prefixes,
  // simulating a prior SDK version's leftover.
  const older = writeFakeModelFile('Qwen3-4B-Q4_K_M.gguf', 'old', Date.now() - 10_000);
  const newer = writeFakeModelFile('Qwen3-4B-Q4_K_M.gguf', 'new', Date.now() - 1_000);

  // loadModel returns a fresh modelId; the SDK is expected to have just
  // written a new file with the same name.
  const chat = freshChat(async () => 'fresh-modelid');
  const result = await chat.load('Qwen3-4B-Q4_K_M.gguf');
  t.is(result.modelName, 'Qwen3-4B-Q4_K_M.gguf');
  const remaining = fs.readdirSync(dir).filter((f) => f.endsWith('_Qwen3-4B-Q4_K_M.gguf'));
  t.is(remaining.length, 1, 'only one copy of the model remains');
  t.ok(remaining[0].includes('new') || fs.statSync(path.join(dir, remaining[0])).mtimeMs >= fs.statSync(newer).mtimeMs - 5, 'the newer (just-written) file is kept');
  t.absent(fs.existsSync(older), 'the older file is removed');
});

test('chat-dedupe - leaves a single file alone (no removal when no duplicates)', async (t) => {
  const dir = path.join(stubbedHome, '.qvac', 'models');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const only = writeFakeModelFile('Qwen3-1.7B-Q4_0.gguf', 'x', Date.now());
  const chat = freshChat(async () => 'mid');
  await chat.load('Qwen3-1.7B-Q4_0.gguf');
  const remaining = fs.readdirSync(dir);
  t.is(remaining.length, 1);
  t.ok(remaining[0].endsWith('_Qwen3-1.7B-Q4_0.gguf'));
  t.ok(fs.existsSync(only));
});

test('chat-dedupe - dedupe failure is logged but does not break load', async (t) => {
  const dir = path.join(stubbedHome, '.qvac', 'models');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  writeFakeModelFile('Qwen3-4B-Q4_K_M.gguf', 'stale', Date.now() - 10_000);
  writeFakeModelFile('Qwen3-4B-Q4_K_M.gguf', 'fresh', Date.now() - 1_000);

  // Patch models.cjs BEFORE chat.cjs requires it, so chat's lazy require
  // inside dedupeModelFiles picks up the patched removeModel. The cache key
  // is the resolved absolute path; chat and the test resolve to the same.
  let removeCalls = 0;
  const modelsPath = require.resolve('../../electron/models.cjs');
  delete require.cache[modelsPath];
  const realModels = require(modelsPath);
  const patched = { ...realModels, removeModel: async () => { removeCalls += 1; throw new Error('forced removeModel failure'); } };
  require.cache[modelsPath] = { exports: patched, id: modelsPath, filename: modelsPath, loaded: true, children: [], paths: [] };

  const chat = freshChat(async () => 'm');
  // load() succeeds even though dedupe's removeModel threw: chat.cjs's
  // dedupe helper catches per-file removeModel errors and continues, so
  // the load path keeps working. A flaky rm on one stale copy should never
  // block chat startup.
  const result = await chat.load('Qwen3-4B-Q4_K_M.gguf');
  t.is(result.modelName, 'Qwen3-4B-Q4_K_M.gguf', 'load still returns the filename');
  t.ok(removeCalls >= 1, 'dedupe attempted to remove the stale copy');
  const survivor = fs.readdirSync(dir).find((f) => f.endsWith('_Qwen3-4B-Q4_K_M.gguf'));
  t.ok(survivor, 'a file with the model name is still on disk');
});

test('chat-dedupe - cleanup runs at end of test session', (t) => {
  os.homedir = realHomedir;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  t.pass();
});
