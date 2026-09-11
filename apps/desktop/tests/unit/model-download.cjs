'use strict';

const test = require('brittle');

const { downloadModel, onDownloadProgress } = require('../../electron/models.cjs');
const { readRegistry } = require('../../shared/model-sideload.cjs');

test('model-download - resolves the modelId to its registry constant and downloads that', async (t) => {
  const entry = readRegistry().get('QWEN3_4B_Q4_K_M');
  const calls = [];
  const fakeSdk = {
    QWEN3_4B_Q4_K_M: { name: 'QWEN3_4B_Q4_K_M' },
    downloadAsset: async ({ assetSrc, onProgress }) => {
      calls.push(assetSrc);
      onProgress({ downloaded: entry.expectedSize, total: entry.expectedSize });
      return 'QWEN3_4B_Q4_K_M';
    },
  };

  const progress = [];
  const off = onDownloadProgress((p) => progress.push(p));
  t.teardown(off);

  const result = await downloadModel(entry.modelId, fakeSdk);
  t.is(result.downloaded, true);
  t.alike(calls, [fakeSdk.QWEN3_4B_Q4_K_M], 'downloadAsset got the actual model constant, not the raw name');
  t.is(progress.length, 1);
  t.alike(progress[0], { name: entry.modelId, loaded: entry.expectedSize, total: entry.expectedSize });
});

test('model-download - an unknown name is rejected before touching the SDK', async (t) => {
  await t.exception(() => downloadModel('not-a-real-model.gguf', {}));
});

// Qwen3-4B-Q4_K_M.gguf shares its modelId with QWEN3_4B_INST_Q4_K_M (the chat
// preset). A chapter-driven download must not silently substitute that one.
test('model-download - a modelId shared with a chat preset resolves to the non-preset constant', async (t) => {
  const entry = readRegistry().get('QWEN3_4B_Q4_K_M');
  const calls = [];
  const fakeSdk = {
    QWEN3_4B_Q4_K_M: { name: 'QWEN3_4B_Q4_K_M' },
    QWEN3_4B_INST_Q4_K_M: { name: 'QWEN3_4B_INST_Q4_K_M' },
    downloadAsset: async ({ assetSrc, onProgress }) => {
      calls.push(assetSrc);
      onProgress({ downloaded: entry.expectedSize, total: entry.expectedSize });
      return 'ok';
    },
  };
  await downloadModel(entry.modelId, fakeSdk);
  t.alike(calls, [fakeSdk.QWEN3_4B_Q4_K_M], 'must not resolve to the chat preset constant');
});
