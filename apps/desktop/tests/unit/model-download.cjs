'use strict';

const test = require('brittle');

const { downloadModel, cancelDownload, onDownloadProgress } = require('../../electron/models.cjs');
const { readRegistry } = require('../../shared/model-sideload.cjs');

test('model-download - resolves the modelId to its registry constant and downloads that', async (t) => {
  const entry = readRegistry().get('QWEN3_4B_Q4_K_M');
  const calls = [];
  const fakeSdk = {
    QWEN3_4B_Q4_K_M: { name: 'QWEN3_4B_Q4_K_M' },
    downloadAsset: ({ assetSrc, onProgress }) => {
      calls.push(assetSrc);
      onProgress({ downloaded: entry.expectedSize, total: entry.expectedSize });
      const done = Promise.resolve('QWEN3_4B_Q4_K_M');
      done.requestId = 'req-qwen';
      return done;
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
test('model-download - a companion setKey resolves to the owning registry constant', async (t) => {
  const calls = [];
  const fakeSdk = {
    BCI_WINDOWED: { name: 'BCI_WINDOWED' },
    downloadAsset: async ({ assetSrc, onProgress }) => {
      calls.push(assetSrc);
      onProgress({ downloaded: 1, total: 1 });
      return 'ok';
    },
  };
  const result = await downloadModel('abc845adefe27931', fakeSdk);
  t.is(result.downloaded, true);
  t.alike(calls, [fakeSdk.BCI_WINDOWED], 'setKey is not a modelId; downloadAsset still gets the constant');
});

test('model-download - cancelDownload aborts the in-flight asset and reports cancelled', async (t) => {
  const entry = readRegistry().get('QWEN3_4B_Q4_K_M');
  let rejectDownload;
  const pending = new Promise((_, rej) => {
    rejectDownload = rej;
  });
  pending.requestId = 'req-download-1';
  const cancelled = [];
  const fakeSdk = {
    QWEN3_4B_Q4_K_M: { name: 'QWEN3_4B_Q4_K_M' },
    downloadAsset: () => pending,
    cancel: async ({ requestId }) => {
      cancelled.push(requestId);
      rejectDownload(Object.assign(new Error('cancelled'), { name: 'InferenceCancelledError' }));
    },
  };
  const downloading = downloadModel(entry.modelId, fakeSdk);
  await new Promise((r) => setImmediate(r));
  const stop = await cancelDownload();
  const result = await downloading;
  t.is(stop.cancelled, true);
  t.is(result.cancelled, true);
  t.is(result.downloaded, false);
  t.alike(cancelled, ['req-download-1']);
});

test('model-download - cancelDownload is a no-op when nothing is in flight', async (t) => {
  const stop = await cancelDownload();
  t.is(stop.cancelled, false);
});

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
