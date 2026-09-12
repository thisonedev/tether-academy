'use strict';

// Which non-lesson parts of the app use a given model, on top of whatever
// chapters model-usage.json already names. Hand-maintained from each backend
// module's own registryKeys; small enough that a generator isn't worth it.

const { CHAT_PRESETS } = require('../shared/chat-presets.cjs');
const { readRegistry } = require('../shared/model-sideload.cjs');

// AI bot: exactly CHAT_PRESETS' modelIds (apps/desktop/shared/chat-presets.cjs).
const AI_BOT_MODEL_IDS = new Set(Object.keys(CHAT_PRESETS));

// Playground: registry constant -> the node label(s) that load it.
// Source: diffusion.cjs's IMAGE_MODELS/VIDEO_MODELS.
const IMAGE_VIDEO_CONSTANTS = {
  SD_V2_1_1B_Q8_0: ['Generate image'],
  FLUX_2_KLEIN_4B_Q4_0: ['Generate image'],
  QWEN3_4B_Q4_K_M: ['Generate image'],
  FLUX_2_KLEIN_4B_VAE: ['Generate image'],
  WAN2_1_T2V_1_3B_FP16: ['Generate video'],
  UMT5_XXL_FP16: ['Generate video'],
  WAN_2_1_COMFYUI_REPACKAGED_VAE: ['Generate video'],
};
// Source: voice.cjs (record-voice, voice-conversation) and transcribe.cjs
// (speech-to-text) both preload WHISPER_TINY; only voice.cjs also needs VAD.
const VOICE_CONSTANTS = {
  WHISPER_TINY: ['Record voice', 'Voice conversation', 'Speech to text'],
  VAD_SILERO_5_1_2: ['Record voice', 'Voice conversation'],
};
// Source: rag.cjs's EMBED_PRESET_KEY.
const RAG_CONSTANTS = { GTE_LARGE_FP16: ['Search documents'] };
// Source: tts.cjs's registryKeys.
const TTS_CONSTANTS = { TTS_MULTILINGUAL_SUPERTONIC3_Q8_0: ['Text to speech'] };
// Source: ocr.cjs's registryKeys.
const OCR_CONSTANTS = { OCR_LATIN: ['Read text from image'] };
// Source: audiogen.cjs's registryKeys (ACE-Step's 4 components).
const MUSIC_CONSTANTS = {
  AUDIOGEN_QWEN3_EMBEDDING_0_6B_Q8_0: ['Generate music'],
  AUDIOGEN_ACESTEP_5HZ_LM_0_6B_Q8_0: ['Generate music'],
  AUDIOGEN_ACESTEP_V15_TURBO_Q4_K_M: ['Generate music'],
  AUDIOGEN_VAE_BF16: ['Generate music'],
};

function buildPlaygroundConstants() {
  const out = {
    ...IMAGE_VIDEO_CONSTANTS,
    ...VOICE_CONSTANTS,
    ...RAG_CONSTANTS,
    ...TTS_CONSTANTS,
    ...OCR_CONSTANTS,
    ...MUSIC_CONSTANTS,
  };
  // ai-agent / ask-doc route through whichever chat preset is active.
  for (const constant of Object.values(CHAT_PRESETS)) {
    out[constant] = ['Ask an AI agent', 'Ask about a document'];
  }
  // translate.cjs: one BERGAMOT_EN_<code> constant per language, derived
  // rather than hand-copied so it can't fall out of sync with the real list.
  try {
    for (const constant of require('./translate.cjs').listNmtRegistryKeys()) {
      out[constant] = ['Translate'];
    }
  } catch {
    // translate.cjs failing to load shouldn't take the rest of this down.
  }
  return out;
}

// modelId -> Playground node labels, resolved once from the constant-keyed
// tables above via readRegistry()'s constant -> modelId mapping.
let _modelIdToPlayground = null;
function modelIdToPlayground() {
  if (_modelIdToPlayground === null) {
    _modelIdToPlayground = new Map();
    const registry = readRegistry();
    for (const [constant, labels] of Object.entries(buildPlaygroundConstants())) {
      const entry = registry.get(constant);
      if (!entry) continue;
      const existing = _modelIdToPlayground.get(entry.modelId) ?? [];
      _modelIdToPlayground.set(entry.modelId, [...new Set([...existing, ...labels])]);
    }
  }
  return _modelIdToPlayground;
}

/** @returns {{ aiBot: boolean, playground: string[] | null }} */
function consumersForModelId(modelId) {
  return {
    aiBot: AI_BOT_MODEL_IDS.has(modelId),
    playground: modelIdToPlayground().get(modelId) ?? null,
  };
}

module.exports = { consumersForModelId, allPlaygroundModelIds: () => [...modelIdToPlayground().keys()] };
