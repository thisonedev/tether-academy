'use strict';

const test = require('brittle');

const { consumersForModelId } = require('../../electron/model-consumers.cjs');

test('model-consumers - AI bot presets are tagged aiBot and route through ask-doc/ai-agent', (t) => {
  const c = consumersForModelId('Qwen3-0.6B-Q4_0.gguf');
  t.is(c.aiBot, true);
  t.ok(c.playground.includes('Ask an AI agent'));
  t.ok(c.playground.includes('Ask about a document'));
});

test('model-consumers - image/video models are tagged Playground, not aiBot', (t) => {
  t.alike(consumersForModelId('stable-diffusion-v2-1-Q8_0.gguf'), {
    aiBot: false,
    playground: ['Generate image'],
  });
  t.ok(consumersForModelId('wan2.1_t2v_1.3B_fp16.safetensors').playground.includes('Generate video'));
});

test('model-consumers - shared voice models cover every node that preloads them', (t) => {
  const tiny = consumersForModelId('ggml-tiny.bin');
  t.ok(tiny.playground.includes('Record voice'));
  t.ok(tiny.playground.includes('Voice conversation'));
  t.ok(tiny.playground.includes('Speech to text'));
});

test('model-consumers - translate.cjs languages resolve to real registry constants', (t) => {
  // Random spot checks rather than all ~30: proves the derived list actually
  // resolved through readRegistry(), not just that the try/catch swallowed it.
  t.ok(consumersForModelId('model.enfr.intgemm.alphas.bin').playground?.includes('Translate'));
});

test('model-consumers - a model nothing else uses gets no Playground tag', (t) => {
  t.alike(consumersForModelId('not-a-real-model.gguf'), { aiBot: false, playground: null });
});
