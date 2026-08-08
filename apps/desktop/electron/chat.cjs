// Local-model chat backend for the AI assistant popover. Streams
// `completion()` deltas back to the renderer over IPC events.
//
// The host does not drive model downloads. If the model file is not on
// disk, `send()` throws a clear error and the UI falls back to the picker.

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createThinkingFilter } = require('./chat-thinking-filter.cjs');
const { buildSystemPrompt } = require('./chat-context.cjs');
const { refreshDocs, getCachedDocs } = require('./chat-docs.cjs');
const { createMarkdownStripper } = require('./chat-strip-markdown.cjs');
const { splitParagraphs } = require('./chat-paragraph-splitter.cjs');

console.log('[chat] module loaded, build = 2026-08-07-adopt-unconditional');

// The constants carry engine metadata (`llamacpp-completion`, etc.) so the
// SDK can route loadModel to the right engine. Passing a bare filename fails
// with MODEL_TYPE_REQUIRED.
const CHAT_PRESETS = {
  'Qwen3-0.6B-Q4_0.gguf': 'QWEN3_600M_INST_Q4',
  'Llama-3.2-1B-Instruct-Q4_0.gguf': 'LLAMA_3_2_1B_INST_Q4_0',
  'Qwen3-1.7B-Q4_0.gguf': 'QWEN3_1_7B_INST_Q4',
  'Qwen3-4B-Q4_K_M.gguf': 'QWEN3_4B_INST_Q4_K_M',
  'Qwen3-8B-Q4_K_M.gguf': 'QWEN3_8B_INST_Q4_K_M',
};

// Resolved lazily so the SDK isn't required at module load (it's only
// available inside Electron's main process once the runtime is up).
function resolvePresetConstant(name) {
  const key = CHAT_PRESETS[name];
  if (!key) return null;
  const sdk = require('@qvac/sdk');
  const constant = sdk[key];
  if (!constant) {
    throw new Error(`@qvac/sdk does not export ${key} in this build`);
  }
  return constant;
}

const events = new EventEmitter();
events.setMaxListeners(50);

let current = {
  filename: null,
  modelId: null,
  preset: null,
};

// In-flight requests, keyed by requestId. Used to cancel a stream mid-flight.
const inflight = new Map();

function emitChunk(chunk) {
  events.emit('chunk', chunk);
}

function emitLoadProgress(progress) {
  events.emit('loadProgress', progress);
}

function isReady() {
  return current.modelId !== null;
}

function currentModel() {
  return current.filename;
}

// Pre-load so the picker can land the user in a clean chat phase with their
// first message being the one they actually typed.
async function load(modelHint) {
  if (!modelHint) {
    throw new Error('modelHint is required');
  }
  await ensureLoaded(modelHint);
  return { modelName: current.filename };
}

async function unload() {
  if (!current.modelId) return;
  const sdk = require('@qvac/sdk');
  if (typeof sdk.unloadModel === 'function') {
    try {
      await sdk.unloadModel({ modelId: current.modelId });
    } catch (err) {
      console.warn('[chat] unload failed', err.message);
    }
  }
  // The SDK's loadModel refuses a second registration until unloadModel's
  // effect is fully visible. A short polling loop is cheaper than rebuilding
  // the app.
  for (let i = 0; i < 20; i++) {
    if (!(await isLoadedBySdk())) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  current = { filename: null, modelId: null, preset: null };
}

// Returns true when the SDK has any model registered (we don't filter by
// name because the SDK's instance name field doesn't always match ours).
async function isLoadedBySdk() {
  const sdk = require('@qvac/sdk');
  if (typeof sdk.getLoadedModelInfo !== 'function') return false;
  try {
    const info = await sdk.getLoadedModelInfo({});
    return !!(info && Array.isArray(info.instances) && info.instances.length > 0);
  } catch {
    return false;
  }
}

// Adopt whatever the SDK already has loaded. Used when loadModel throws
// "already registered": the file is loaded, just under a modelId we don't
// know yet, so ask the SDK which one it is.
async function adoptLoadedFromSdk() {
  const sdk = require('@qvac/sdk');
  if (typeof sdk.getLoadedModelInfo !== 'function') return null;
  try {
    const info = await sdk.getLoadedModelInfo({});
    console.log('[chat] getLoadedModelInfo ->', JSON.stringify(info, null, 2));
    if (!info || typeof info !== 'object') return null;
    // The SDK has used two shapes across versions. Handle both.
    let instances = null;
    if (Array.isArray(info.instances)) {
      instances = info.instances;
    } else if (Array.isArray(info)) {
      instances = info;
    } else if (Array.isArray(info.models)) {
      instances = info.models;
    } else if (info.modelId || info.name) {
      instances = [info];
    }
    if (!instances || instances.length === 0) return null;
    const inst = instances[0];
    if (!inst || typeof inst !== 'object') return null;
    const modelId = inst.modelId || inst.id;
    const name = inst.name || inst.modelName || modelId;
    if (!modelId) return null;
    return { modelId, name };
  } catch (err) {
    console.log('[chat] getLoadedModelInfo threw', err && err.message);
    return null;
  }
}

async function ensureLoaded(filename) {
  if (current.filename === filename && current.modelId !== null) return current;
  const modelSrc = resolvePresetConstant(filename);
  if (!modelSrc) {
    throw new Error(`no chat preset registered for ${filename}`);
  }
  if (current.modelId && current.filename !== filename) {
    await unload();
  }
  // We deliberately don't compare names: the SDK's instance name field may
  // not match the preset constant's name field (case, version, etc.), and
  // the right thing for a stuck user is to use whatever the SDK already has.
  // The user can switch models explicitly later.
  const existing = await adoptLoadedFromSdk();
  console.log('[chat] ensureLoaded start', { filename, preset: modelSrc.name, existing });
  if (existing && existing.modelId) {
    current = { filename, modelId: existing.modelId, preset: modelSrc.name };
    return current;
  }
  const sdk = require('@qvac/sdk');
  if (typeof sdk.loadModel !== 'function') {
    throw new Error('@qvac/sdk does not export loadModel in this build');
  }
  emitLoadProgress({ modelName: filename, loaded: 0, total: 0 });
  let modelId;
  // We pass 4096 even for the 0.6B so the assistant can hold a longer
  // lesson reference plus a short answer. If the running addon ignores the
  // value (the 4B preset reports 1024 in early builds), the host still
  // builds a prompt that fits the worst-case window.
  const ctxSize = 4096;
  try {
    modelId = await sdk.loadModel({
      modelSrc,
      modelConfig: { ctx_size: ctxSize },
      onProgress: (p) => {
      if (p && typeof p.loaded === 'number' && typeof p.total === 'number') {
        emitLoadProgress({ modelName: filename, loaded: p.loaded, total: p.total });
      }
    },
    });
  } catch (err) {
    // The SDK refuses to register a file twice. Adopt whatever it has
    // already loaded. We do this unconditionally on any loadModel failure:
    // the user is never more stuck by adopting the wrong model for a moment
    // than by seeing the same error forever.
    const fallback = await adoptLoadedFromSdk();
    console.log('[chat] ensureLoaded caught error, fallback =', fallback);
    if (fallback && fallback.modelId) {
      current = { filename, modelId: fallback.modelId, preset: modelSrc.name };
      return current;
    }
    throw err;
  }
  current = { filename, modelId, preset: modelSrc.name };
  return current;
}

function newRequestId() {
  return `chat-${crypto.randomUUID()}`;
}

// Prefer the smallest chat model that's already on disk. The renderer can
// override with an explicit hint when the picker has a specific recommendation.
async function pickDefaultChatModel() {
  const { listModels } = require('./models.cjs');
  const installed = await listModels();
  const installedNames = new Set(installed.map((m) => m.name));
  // Presets are listed smallest first in CHAT_PRESETS, so the first match wins.
  for (const filename of Object.keys(CHAT_PRESETS)) {
    if (installedNames.has(filename)) return filename;
  }
  return null;
}

// Approximate: llama.cpp uses BPE and counts roughly 4 chars per token for
// English+code. The running addon does the authoritative count and rejects
// overflow itself; this only keeps the prompt below the worst-case window.
function approxTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

function approxContextWindow(filename) {
  // Earlier llama.cpp builds cap at 1024 unless `modelConfig.ctx_size` is
  // honored. The 0.6B preset keeps the 1024 default and the lesson
  // reference has to fit alongside the question. The Qwen3-4B and 8B
  // presets sometimes honor the 4096 we send, sometimes don't, so treat
  // both as 1024 by default and let the user re-prompt if it overflows.
  if (!filename) return 1024;
  if (filename === 'Qwen3-0.6B-Q4_0.gguf') return 1024;
  return 2048;
}

async function send({ messages, lessonKey, lessonReference, useFullDocs, modelHint }) {
  const sdk = require('@qvac/sdk');
  if (typeof sdk.completion !== 'function') {
    throw new Error('@qvac/sdk does not export completion in this build');
  }

  const requestId = newRequestId();

  // Pick a model in priority order: explicit hint from the renderer, anything
  // already loaded, otherwise the smallest installed chat model.
  if (modelHint && modelHint !== current.filename) {
    await ensureLoaded(modelHint);
  } else if (!current.modelId) {
    const fallback = await pickDefaultChatModel();
    if (fallback) {
      await ensureLoaded(fallback);
    } else {
      throw new Error('no model loaded; pick one in the AI assistant panel first');
    }
  }

  const modelName = current.filename;
  const ctxWindow = approxContextWindow(modelName);

  // Carve out a third of the window for the lesson reference. The system
  // prompt base is ~250 tokens; the user turn is ~30; the answer gets the rest.
  const lessonBudget = Math.max(64, Math.floor((ctxWindow - 100) / 3));
  const lessonContext = typeof lessonReference === 'string' && lessonReference.length > 0
    ? { content: lessonReference.slice(0, lessonBudget * 4) }
    : null;

  // Inject docs only when the user is asking about an API. The 12 KiB cap
  // leaves room for the lesson reference plus a multi-paragraph answer.
  const wantsApiDetails = /(\b[A-Z][A-Z0-9_]{2,}|@[\w./-]+|\bclass\b|\bfunction\b|\bapi\b|\bmethod\b|\bmodule\b|\btype\b|\binterface\b)/.test(
    (messages[messages.length - 1]?.content || ''),
  );
  const docsBudget = Math.floor(ctxWindow / 4);
  const docs = useFullDocs && wantsApiDetails
    ? (getCachedDocs() || (await refreshDocs().catch(() => null)) || null)
    : null;
  const docsCapped = docs ? docs.slice(0, docsBudget * 4) : null;

  let systemPrompt = buildSystemPrompt(lessonKey, lessonContext, docsCapped);
  if (approxTokens(systemPrompt) > ctxWindow - 200) {
    systemPrompt = buildSystemPrompt(lessonKey, lessonContext, null);
  }
  if (approxTokens(systemPrompt) > ctxWindow - 200) {
    systemPrompt = buildSystemPrompt(lessonKey, null, null);
  }

  // Send only the last user turn when the window is tight, to keep the
  // answer room bigger.
  const priorRoom = approxTokens(systemPrompt) + 50;
  const answerBudget = Math.max(200, ctxWindow - priorRoom);
  const userOnly = messages.length > 0 && messages[messages.length - 1]?.role === 'user';
  const tail = userOnly ? messages.slice(-1) : messages.slice(-2);

  const history = [
    { role: 'system', content: systemPrompt },
    ...tail,
  ];

  const controller = new AbortController();
  inflight.set(requestId, controller);

  // The SDK yields event objects ({type, seq, text}) per token, not raw
  // strings. We forward contentDelta (and rawDelta as a fallback). We emit
  // one final 'done' chunk whether the stream succeeds, errors, or is cancelled.
  (async () => {
    let emitted = false;
    const thinkingFilter = createThinkingFilter();
    const stripper = createMarkdownStripper();
    // Buffer sanitised text so we can post-process into paragraphs before
    // handing the final visible text to the renderer. The renderer
    // concatenates deltas, so we emit a single `replace: true` delta at the
    // end to swap the assistant message wholesale.
    let assembled = '';
    try {
      const result = sdk.completion({
        modelId: current.modelId,
        history,
        stream: true,
        captureThinking: false,
        signal: controller.signal,
        generationParams: { predict: answerBudget },
      });
      for await (const event of result.events) {
        if (controller.signal.aborted) break;
        if (!event || typeof event !== 'object') continue;
        const type = event.type;
        if ((type === 'contentDelta' || type === 'rawDelta') && typeof event.text === 'string' && event.text.length > 0) {
          const cleaned = stripper.push(thinkingFilter.push(event.text));
          if (cleaned.length > 0) {
            assembled += cleaned;
            emitted = true;
          }
        } else if (type === 'toolError' && typeof event.error === 'string') {
          emitChunk({ requestId, delta: '', done: false, error: null });
          emitChunk({ requestId, delta: '', done: true, error: `tool error: ${event.error}` });
          return;
        }
      }
      const trailing = thinkingFilter.flush();
      if (trailing.length > 0) {
        const cleaned = stripper.push(trailing);
        if (cleaned.length > 0) {
          assembled += cleaned;
          emitted = true;
          emitChunk({ requestId, delta: cleaned, done: false, error: null });
        }
      }
      const tail = stripper.flush();
      if (tail.length > 0) {
        assembled += tail;
        emitted = true;
        emitChunk({ requestId, delta: tail, done: false, error: null });
      }
      // Replace the whole assistant message with the paragraph-split version
      // so the user sees visible paragraph breaks even when the model emits
      // one run-on paragraph.
      const finalised = splitParagraphs(assembled);
      if (finalised.length > 0 && (finalised !== assembled || !emitted)) {
        emitChunk({ requestId, delta: finalised, done: false, replace: true, error: null });
      }
      if (!emitted) {
        emitChunk({
          requestId,
          delta: '',
          done: true,
          error: 'Model produced no output. Try a different model or a shorter prompt.',
        });
      } else {
        emitChunk({ requestId, delta: '', done: true, error: null });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const friendly = message.match(/context overflow at prefill step/i)
        ? 'The lesson prompt is larger than the model context window. Switch to a model with a wider window (1.7B or 4B) in Settings > AI bot, or ask a shorter question.'
        : message;
      emitChunk({ requestId, delta: '', done: true, error: friendly });
    } finally {
      inflight.delete(requestId);
    }
  })();

  return { requestId, modelName: current.filename };
}

function stop(requestId) {
  const controller = inflight.get(requestId);
  if (!controller) return false;
  controller.abort();
  inflight.delete(requestId);
  return true;
}

function onChunk(callback) {
  events.on('chunk', callback);
  return () => events.off('chunk', callback);
}

function onLoadProgress(callback) {
  events.on('loadProgress', callback);
  return () => events.off('loadProgress', callback);
}

module.exports = {
  isReady,
  currentModel,
  load,
  send,
  stop,
  onChunk,
  onLoadProgress,
  unload,
  docsStatus: () => docsStatusFromCache(),
  docsRefresh: async () => {
    const body = await refreshDocs();
    return { ok: !!body, ...docsStatusFromCache() };
  },
  // Exposed for tests.
  _inflight: inflight,
};

function docsStatusFromCache() {
  const { docsStatus } = require('./chat-docs.cjs');
  return docsStatus();
}
