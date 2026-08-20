'use strict';

// Qwen3-4B-Q4_K_M.gguf is both a chat preset and a lesson model, under two
// registry entries with different cache names. Keyed on the display name, a
// complete lesson copy stood in for a chat copy still downloading.

const test = require('brittle');

const { CHAT_PRESETS } = require('../../shared/chat-presets.cjs');
const { cacheFileName } = require('../../shared/model-sideload.cjs');

test('chat-presets - every chat model names an SDK constant', (t) => {
  for (const [file, key] of Object.entries(CHAT_PRESETS)) {
    t.ok(file.endsWith('.gguf'), `${file} is a model file`);
    t.ok(/^[A-Z][A-Z0-9_]+$/.test(key), `${key} looks like a registry constant`);
  }
});

// The collision this whole fix exists for: same display name, different files.
test('chat-presets - the chat 4B and the lesson 4B are different files', (t) => {
  const chat4b = cacheFileName(
    'qvac_models_compiled/ggml/qwen3/2026-07-22/Qwen3-4B-Q4_K_M.gguf',
  );
  const lesson4b = cacheFileName(
    'unsloth/Qwen3-4B-GGUF/resolve/9b5c4f3506ac99d74e59ecd9aa9abb05537b7f59/Qwen3-4B-Q4_K_M.gguf',
  );
  t.not(chat4b, lesson4b, 'two cache names');
  t.ok(chat4b.endsWith('_Qwen3-4B-Q4_K_M.gguf'), 'sharing one display name');
  t.ok(lesson4b.endsWith('_Qwen3-4B-Q4_K_M.gguf'));
});

// The console asks for a recommendation with no lesson in mind. The schema
// rejected null, the renderer swallowed the error, and the picker sat empty.
test('chat-presets - a recommendation can be asked for without a lesson', (t) => {
  const v = require('@academy/validation');
  t.execution(() => v.parseIpc(v.modelLessonKeySchema, null, 'recommend'));
  t.execution(() => v.parseIpc(v.modelLessonKeySchema, { chapter: 'rag', lesson: 'reindex' }, 'recommend'));
  t.exception(() => v.parseIpc(v.modelLessonKeySchema, { chapter: 'rag' }, 'recommend'));
});

// Reversing the map is only correct while it stays ordered smallest first.
test('chat-presets - the default pick prefers the largest, not the first listed', (t) => {
  const names = Object.keys(CHAT_PRESETS);
  t.is(names[0], 'Qwen3-0.6B-Q4_0.gguf', 'the map is smallest first');
  t.is(names[names.length - 1], 'Qwen3-8B-Q4_K_M.gguf', 'so largest first means reversing it');
});
