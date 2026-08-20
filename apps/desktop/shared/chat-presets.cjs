// Which SDK registry constant backs each chat model file. Shared so the
// catalogue can resolve the file chat will actually open, without importing
// chat.cjs, which imports the catalogue back.
'use strict';

const CHAT_PRESETS = {
  'Qwen3-0.6B-Q4_0.gguf': 'QWEN3_600M_INST_Q4',
  'Qwen3-1.7B-Q4_0.gguf': 'QWEN3_1_7B_INST_Q4',
  'Qwen3-4B-Q4_K_M.gguf': 'QWEN3_4B_INST_Q4_K_M',
  'Qwen3-8B-Q4_K_M.gguf': 'QWEN3_8B_INST_Q4_K_M',
};

module.exports = { CHAT_PRESETS };
