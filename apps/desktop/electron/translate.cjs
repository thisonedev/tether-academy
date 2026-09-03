'use strict';

// Bridges the SDK's per-language Bergamot NMT models, so Translate can stop
// asking the general chat model. English -> target only; each language is
// its own small model, loaded independently of chat.cjs's chat model.

const { ensureModels } = require('../shared/model-fetch.cjs');

// Maps a language label (matches BERGAMOT_EN_TARGETS in playground-node-defs.ts)
// to its @qvac/sdk registry constant name and the lowercase code loadModel's
// `modelConfig.to` wants (schemas/translation-config.js's BERGAMOT_LANGUAGES
// enum, not the registry constant's own casing). Both cross-checked against
// the installed @qvac/sdk: every BERGAMOT_EN_* constant it exports, and every
// code BERGAMOT_LANGUAGES accepts.
const NMT_PRESETS = {
  Arabic: { key: 'BERGAMOT_EN_AR', to: 'ar' },
  Azerbaijani: { key: 'BERGAMOT_EN_AZ', to: 'az' },
  Bulgarian: { key: 'BERGAMOT_EN_BG', to: 'bg' },
  Bengali: { key: 'BERGAMOT_EN_BN', to: 'bn' },
  Bosnian: { key: 'BERGAMOT_EN_BS', to: 'bs' },
  Catalan: { key: 'BERGAMOT_EN_CA', to: 'ca' },
  Czech: { key: 'BERGAMOT_EN_CS', to: 'cs' },
  Danish: { key: 'BERGAMOT_EN_DA', to: 'da' },
  German: { key: 'BERGAMOT_EN_DE', to: 'de' },
  Greek: { key: 'BERGAMOT_EN_EL', to: 'el' },
  Spanish: { key: 'BERGAMOT_EN_ES', to: 'es' },
  Estonian: { key: 'BERGAMOT_EN_ET', to: 'et' },
  Persian: { key: 'BERGAMOT_EN_FA', to: 'fa' },
  Finnish: { key: 'BERGAMOT_EN_FI', to: 'fi' },
  French: { key: 'BERGAMOT_EN_FR', to: 'fr' },
  Gujarati: { key: 'BERGAMOT_EN_GU', to: 'gu' },
  Hebrew: { key: 'BERGAMOT_EN_HE', to: 'he' },
  Hindi: { key: 'BERGAMOT_EN_HI', to: 'hi' },
  Croatian: { key: 'BERGAMOT_EN_HR', to: 'hr' },
  Hungarian: { key: 'BERGAMOT_EN_HU', to: 'hu' },
  Indonesian: { key: 'BERGAMOT_EN_ID', to: 'id' },
  Icelandic: { key: 'BERGAMOT_EN_IS', to: 'is' },
  Italian: { key: 'BERGAMOT_EN_IT', to: 'it' },
  Japanese: { key: 'BERGAMOT_EN_JA', to: 'ja' },
  Kannada: { key: 'BERGAMOT_EN_KN', to: 'kn' },
  Korean: { key: 'BERGAMOT_EN_KO', to: 'ko' },
  Lithuanian: { key: 'BERGAMOT_EN_LT', to: 'lt' },
  Latvian: { key: 'BERGAMOT_EN_LV', to: 'lv' },
  Malayalam: { key: 'BERGAMOT_EN_ML', to: 'ml' },
  Malay: { key: 'BERGAMOT_EN_MS', to: 'ms' },
  'Norwegian Bokmål': { key: 'BERGAMOT_EN_NB', to: 'nb' },
  Dutch: { key: 'BERGAMOT_EN_NL', to: 'nl' },
  Norwegian: { key: 'BERGAMOT_EN_NO', to: 'no' },
  Polish: { key: 'BERGAMOT_EN_PL', to: 'pl' },
  Portuguese: { key: 'BERGAMOT_EN_PT', to: 'pt' },
  Romanian: { key: 'BERGAMOT_EN_RO', to: 'ro' },
  Russian: { key: 'BERGAMOT_EN_RU', to: 'ru' },
  Slovak: { key: 'BERGAMOT_EN_SK', to: 'sk' },
  Slovenian: { key: 'BERGAMOT_EN_SL', to: 'sl' },
  Albanian: { key: 'BERGAMOT_EN_SQ', to: 'sq' },
  Serbian: { key: 'BERGAMOT_EN_SR', to: 'sr' },
  Swedish: { key: 'BERGAMOT_EN_SV', to: 'sv' },
  Tamil: { key: 'BERGAMOT_EN_TA', to: 'ta' },
  Telugu: { key: 'BERGAMOT_EN_TE', to: 'te' },
  Thai: { key: 'BERGAMOT_EN_TH', to: 'th' },
  Turkish: { key: 'BERGAMOT_EN_TR', to: 'tr' },
  Ukrainian: { key: 'BERGAMOT_EN_UK', to: 'uk' },
  Vietnamese: { key: 'BERGAMOT_EN_VI', to: 'vi' },
  Chinese: { key: 'BERGAMOT_EN_ZH', to: 'zh' },
};

const IDLE_UNLOAD_MS = 20 * 60 * 1000;

let current = { language: null, modelId: null };
let idleTimer = null;

function clearIdleTimer() {
  if (!idleTimer) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

function touchIdleTimer() {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    unload().catch((err) => console.warn('[translate] idle unload failed', err && err.message));
  }, IDLE_UNLOAD_MS);
  if (typeof idleTimer.unref === 'function') idleTimer.unref();
}

function isNmtLanguage(language) {
  return Object.prototype.hasOwnProperty.call(NMT_PRESETS, language);
}

function resolvePresetConstant(language) {
  const preset = NMT_PRESETS[language];
  if (!preset) return null;
  const sdk = require('@qvac/sdk');
  const constant = sdk[preset.key];
  if (!constant) {
    throw new Error(`@qvac/sdk does not export ${preset.key} in this build`);
  }
  return constant;
}

async function unload() {
  clearIdleTimer();
  if (!current.modelId) return;
  const modelId = current.modelId;
  const sdk = require('@qvac/sdk');
  if (typeof sdk.unloadModel === 'function') {
    try {
      await sdk.unloadModel({ modelId });
    } catch (err) {
      console.warn('[translate] unload failed', err && err.message);
    }
  }
  current = { language: null, modelId: null };
}

async function ensureLoaded(language) {
  if (current.language === language && current.modelId !== null) {
    touchIdleTimer();
    return current;
  }
  const preset = NMT_PRESETS[language];
  const modelSrc = resolvePresetConstant(language);
  if (!preset || !modelSrc) {
    throw new Error(`no Bergamot NMT model registered for ${language}`);
  }
  if (current.modelId && current.language !== language) {
    await unload();
  }
  const sdk = require('@qvac/sdk');
  if (typeof sdk.loadModel !== 'function') {
    throw new Error('@qvac/sdk does not export loadModel in this build');
  }
  await ensureModels([preset.key], {}).catch(() => {});
  // NMT's loadModel branch is a discriminated union on modelType, and its
  // modelConfig (unlike the LLM branch's) is required, not optional: engine,
  // from, and to, matching schemas/translation-config.js's bergamotConfigSchema.
  const modelId = await sdk.loadModel({
    modelSrc,
    modelType: 'nmtcpp-translation',
    modelConfig: { engine: 'Bergamot', from: 'en', to: preset.to },
  });
  current = { language, modelId };
  touchIdleTimer();
  return current;
}

/** Non-streaming: the playground node wants one final string, not tokens. */
async function translateText(text, language) {
  const sdk = require('@qvac/sdk');
  if (typeof sdk.translate !== 'function') {
    throw new Error('@qvac/sdk does not export translate in this build');
  }
  await ensureLoaded(language);
  const result = sdk.translate({
    modelId: current.modelId,
    text,
    stream: false,
    modelType: 'nmtcpp-translation',
  });
  return result.text;
}

module.exports = {
  translateText,
  isNmtLanguage,
  listNmtLanguages: () => Object.keys(NMT_PRESETS),
  unload,
};
