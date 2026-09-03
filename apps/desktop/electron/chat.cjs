// The host does not drive model downloads: `send()` throws if the model
// file is not on disk, and the UI falls back to the picker.

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createThinkingFilter } = require('./chat-thinking-filter.cjs');
const {
  buildSystemPrompt,
  buildVerifySystemPrompt,
  buildSecuritySystemPrompt,
  buildCompactSecurityPrompt,
} = require('./chat-context.cjs');
const { refreshDocs, getCachedDocs } = require('./chat-docs.cjs');
const { createMarkdownStripper } = require('./chat-strip-markdown.cjs');
const { splitParagraphs } = require('./chat-paragraph-splitter.cjs');
const { isKnownLessonCode } = require('./lesson-match.cjs');
const { normalizeLessonCode } = require('@academy/validation/lesson-code');

console.log('[chat] module loaded, build = 2026-08-11-adopt-from-error-message');

// The constants carry engine metadata (`llamacpp-completion`, etc.) so the
// SDK can route loadModel to the right engine. Passing a bare filename fails
// with MODEL_TYPE_REQUIRED.
// Llama-3.2-1B-Instruct-Q4_0.gguf is excluded: that's a delegated-inference lesson download, not an AI-bot model.
const { CHAT_PRESETS } = require('../shared/chat-presets.cjs');
const { ensureModels } = require('../shared/model-fetch.cjs');

// What loadModel asks the addon for, and what every prompt here is sized
// against. See approxContextWindow for why the request is trusted.
const MODEL_CTX_SIZE = 4096;

// A chat model is several GB resident in RAM/VRAM; nothing here ever evicted
// it before, so an idle session held that memory indefinitely. 20 minutes of
// no send/verify/securityScan call frees it back up.
const IDLE_UNLOAD_MS = 20 * 60 * 1000;

function isChatPreset(name) {
  return Object.prototype.hasOwnProperty.call(CHAT_PRESETS, name);
}

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

let idleTimer = null;

function clearIdleTimer() {
  if (!idleTimer) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

// Called on every resolveModel()/load(): a model still mid-use never idles
// out mid-run, since each request restarts the countdown from its own start.
function touchIdleTimer() {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    unload().catch((err) => console.warn('[chat] idle unload failed', err && err.message));
  }, IDLE_UNLOAD_MS);
  if (typeof idleTimer.unref === 'function') idleTimer.unref();
}

// Keyed by requestId so stop() can find and cancel a stream.
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
  touchIdleTimer();
  return { modelName: current.filename };
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
      console.warn('[chat] unload failed', err.message);
    }
  }
  // The SDK's loadModel refuses a second registration until unloadModel's
  // effect is fully visible. A short polling loop is cheaper than rebuilding
  // the app.
  for (let i = 0; i < 20; i++) {
    if (!(await isLoadedBySdk(modelId))) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  current = { filename: null, modelId: null, preset: null };
}

async function isLoadedBySdk(modelId) {
  const sdk = require('@qvac/sdk');
  if (typeof sdk.getLoadedModelInfo !== 'function' || !modelId) return false;
  try {
    await sdk.getLoadedModelInfo({ modelId });
    return true;
  } catch {
    return false;
  }
}

function parseAlreadyRegisteredModelId(err) {
  const message = err instanceof Error ? err.message : String(err);
  const match = /Model with ID "([^"]+)" is already registered/.exec(message);
  return match ? match[1] : null;
}

// "Already registered" only proves a modelId exists, not that its download
// finished (a racing concurrent load can still be mid-transfer).
async function isCompleteOnDisk(filename) {
  const { listModels, knownGoodSizes } = require('./models.cjs');
  const sizes = knownGoodSizes(filename);
  if (!sizes) return true;
  const items = await listModels();
  const entry = items.find((it) => it.kind === 'single' && it.name === filename);
  return !!entry && sizes.has(entry.sizeBytes);
}

// Dedupe on-disk files for the same chat model. The SDK writes each
// download as `<sourceHash>_<filename>` where sourceHash is
// generateShortHash(registryPath); an SDK upgrade that bumps the bundled
// descriptor's path produces a fresh file without removing the prior one,
// so the picker sees two rows for the same model.
async function dedupeModelFiles(filename) {
  const { listModels, removeModel } = require('./models.cjs');
  const items = await listModels();
  const group = items.filter((it) => it.kind === 'single' && it.name === filename);
  if (group.length < 2) return { kept: null, removed: 0, freedBytes: 0 };
  const withMtime = await Promise.all(
    group.map(async (it) => {
      const st = await require('node:fs/promises').stat(
        require('node:path').join(require('node:os').homedir(), '.qvac', 'models', it.id),
      ).catch(() => null);
      return { ...it, mtimeMs: st ? st.mtimeMs : 0 };
    }),
  );
  // Complete beats incomplete regardless of mtime, so a stalled retry never displaces the good copy.
  withMtime.sort((a, b) => (b.complete ? 1 : 0) - (a.complete ? 1 : 0) || b.mtimeMs - a.mtimeMs);
  const kept = withMtime[0];
  let removed = 0;
  let freedBytes = 0;
  for (const it of withMtime.slice(1)) {
    try {
      const r = await removeModel(it.id);
      removed += r.removed;
      freedBytes += r.freedBytes;
    } catch (err) {
      console.warn('[chat] dedupe remove failed', it.id, err && err.message);
    }
  }
  return { kept, removed, freedBytes };
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
  console.log('[chat] ensureLoaded start', { filename, preset: modelSrc.name });
  const sdk = require('@qvac/sdk');
  if (typeof sdk.loadModel !== 'function') {
    throw new Error('@qvac/sdk does not export loadModel in this build');
  }
  emitLoadProgress({ modelName: filename, loaded: 0, total: 0 });
  // See shared/model-fetch.cjs: takes the registry's named source when the
  // model is missing.
  await ensureModels([CHAT_PRESETS[filename]], {
    onEvent: (e) => {
      if (e.phase === 'progress') {
        emitLoadProgress({ modelName: filename, loaded: e.downloaded, total: e.total });
      }
    },
  }).catch(() => {});
  let modelId;
  // Every prompt in this file is budgeted against this number, so the two read
  // it from the same constant instead of agreeing by hand.
  const ctxSize = MODEL_CTX_SIZE;
  try {
    modelId = await sdk.loadModel({
      modelSrc,
      modelConfig: { ctx_size: ctxSize },
      onProgress: (p) => {
      // The SDK's modelProgress event uses `downloaded`, not `loaded`.
      if (p && typeof p.downloaded === 'number' && typeof p.total === 'number') {
        emitLoadProgress({ modelName: filename, loaded: p.downloaded, total: p.total });
      }
    },
    });
  } catch (err) {
    // The SDK refuses to register a file twice; recover the existing modelId from the error text and adopt it.
    const existingId = parseAlreadyRegisteredModelId(err);
    console.log('[chat] ensureLoaded caught error, existingId =', existingId);
    if (existingId && (await isCompleteOnDisk(filename))) {
      current = { filename, modelId: existingId, preset: modelSrc.name };
      try {
        const { kept, removed, freedBytes } = await dedupeModelFiles(filename);
        if (removed > 0) {
          console.log('[chat] deduped (adopt)', { filename, kept: kept && kept.id, removed, freedBytes });
        }
      } catch (err) {
        console.warn('[chat] dedupe failed (adopt)', err && err.message);
      }
      return current;
    }
    if (existingId) {
      // Points at a file that never finished downloading; tear it down instead of handing out a broken model.
      console.warn('[chat] adopted registration points at an incomplete file; discarding', { filename, existingId });
      try {
        await sdk.unloadModel({ modelId: existingId });
      } catch (unloadErr) {
        console.warn('[chat] unload of incomplete registration failed', unloadErr && unloadErr.message);
      }
      try {
        const { listModels, removeModel } = require('./models.cjs');
        const items = await listModels();
        const bad = items.find((it) => it.kind === 'single' && it.name === filename);
        if (bad) await removeModel(bad.id);
      } catch (cleanupErr) {
        console.warn('[chat] cleanup of incomplete file failed', cleanupErr && cleanupErr.message);
      }
      throw new Error(`${filename} did not finish downloading. Pick it again in Settings to retry.`);
    }
    throw err;
  }
  current = { filename, modelId, preset: modelSrc.name };
  try {
    const { kept, removed, freedBytes } = await dedupeModelFiles(filename);
    if (removed > 0) {
      console.log('[chat] deduped', { filename, kept: kept && kept.id, removed, freedBytes });
    }
  } catch (err) {
    console.warn('[chat] dedupe failed', err && err.message);
  }
  return current;
}

function newRequestId() {
  return `chat-${crypto.randomUUID()}`;
}

/** Whether the file this preset loads is on disk. */
async function isChatModelInstalled(filename) {
  const { catalogue } = require('./models.cjs');
  const entry = (await catalogue()).find((e) => e.name === filename && e.family === 'chat');
  return Boolean(entry?.installed);
}

// Prefer the largest chat model on disk. CHAT_PRESETS runs smallest first, so
// reverse it. catalogue() keys on the cache file, which keeps the two registry
// entries that share a display name apart.
async function pickDefaultChatModel() {
  const { catalogue } = require('./models.cjs');
  const installed = new Set(
    (await catalogue()).filter((e) => e.family === 'chat' && e.installed).map((e) => e.name),
  );
  for (const filename of Object.keys(CHAT_PRESETS).reverse()) {
    if (installed.has(filename)) return filename;
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

// Small local models sometimes pad an answer with a fake conversation recap
// ("Turn 1: user asks: ..."). It isn't wrapped in <think>, so the thinking
// filter never catches it; drop any paragraph that starts with the pattern.
function stripTurnRecap(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text
    .split(/\n{2,}/)
    .filter((para) => !/^▸?\s*turn\s+\d+\s*:/i.test(para.trim()))
    .join('\n\n')
    .trim();
}

function approxContextWindow(filename) {
  // The addon honours the ctx_size ensureLoaded asks for. Measured against the
  // 0.6B, 1.7B and 4B presets: each answered a 3.8k-token prompt, and 4.8k
  // overflowed at exactly `max context tokens 4096`. Nothing in the SDK reports
  // the window back, so the value we set is the only one to go on.
  if (!filename) return 1024;
  return MODEL_CTX_SIZE;
}

// Pick a model in priority order: explicit hint from the renderer, anything
// already loaded, otherwise the smallest installed chat model. Shared by
// send() and verify() so the priority order only lives in one place.
async function resolveModel(modelHint) {
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
  touchIdleTimer();
  return current.filename;
}

async function send({ messages, lessonKey, lessonReference, useFullDocs, modelHint }) {
  const sdk = require('@qvac/sdk');
  if (typeof sdk.completion !== 'function') {
    throw new Error('@qvac/sdk does not export completion in this build');
  }

  const requestId = newRequestId();
  const modelName = await resolveModel(modelHint);
  const ctxWindow = approxContextWindow(modelName);

  // Carve out a third of the window for the lesson reference. The system
  // prompt base is ~250 tokens; the user turn is ~30; the answer gets the rest.
  const lessonBudget = Math.max(64, Math.floor((ctxWindow - 100) / 3));
  const lessonContext = typeof lessonReference === 'string' && lessonReference.length > 0
    ? { content: lessonReference.slice(0, lessonBudget * 4) }
    : null;

  // Inject docs only when the user is asking about an API. The 12 KiB cap
  // leaves room for the lesson reference plus a multi-paragraph answer.
  const lastUserContent = messages[messages.length - 1]?.content || '';
  const wantsApiDetails =
    /(\b[A-Z][A-Z0-9_]{2,}|@[\w./-]+|\bclass\b|\bfunction\b|\bapi\b|\bmethod\b|\bmodule\b|\btype\b|\binterface\b|\bmcp\b|\bqvac\b|\bsdk\b|\brag\b|\bgguf\b|\bllm\b)/.test(
      lastUserContent,
    ) || /\b(?:what'?s|what is|define|explain)\s+(?:an?\s+|the\s+)?[\w().'-]{1,24}\s*\??\s*$/i.test(lastUserContent.trim());
  const docsBudget = Math.floor(ctxWindow / 4);
  const docs = useFullDocs && wantsApiDetails
    ? (getCachedDocs() || (await refreshDocs().catch(() => null)) || null)
    : null;
  const docsCapped = docs ? docs.slice(0, docsBudget * 4) : null;
  const docsWereRequested = useFullDocs && wantsApiDetails;

  let systemPrompt = buildSystemPrompt(lessonKey, lessonContext, docsCapped, docsWereRequested);
  if (approxTokens(systemPrompt) > ctxWindow - 200) {
    systemPrompt = buildSystemPrompt(lessonKey, lessonContext, null, docsWereRequested);
  }
  if (approxTokens(systemPrompt) > ctxWindow - 200) {
    systemPrompt = buildSystemPrompt(lessonKey, null, null, docsWereRequested);
  }

  // Split what's left after the system prompt between the reply and prior turns, most
  // recent first, so a conversation isn't forgotten the moment it goes past one exchange.
  const priorRoom = approxTokens(systemPrompt) + 50;
  const available = Math.max(0, ctxWindow - priorRoom);
  const answerBudget = Math.max(200, Math.floor(available * 0.6));
  const historyBudget = Math.max(0, available - answerBudget);
  const tail = [];
  let historyUsed = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const cost = approxTokens(messages[i]?.content || '') + 4;
    if (tail.length > 0 && historyUsed + cost > historyBudget) break;
    tail.unshift(messages[i]);
    historyUsed += cost;
  }

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
      // one run-on paragraph. Skipped outside lessons: splitParagraphs collapses
      // every internal newline, which shreds Markdown tables and lists that the
      // no-lesson system prompt explicitly asked the model to produce.
      const recapStripped = stripTurnRecap(assembled);
      const finalised = lessonKey ? splitParagraphs(recapStripped) : recapStripped;
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

const VERIFY_VERDICTS = new Set(['complete', 'different-but-valid', 'unfinished', 'wrong']);

// Extracts the model's JSON verdict from its raw text output (some local
// models wrap JSON in prose or markdown fences despite instructions not to).
// Returns null on any shape mismatch or unrecognized verdict; the caller
// reports that as an error rather than showing a mis-parsed result.
function parseVerifyResponse(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let parsed = null;
  if (start !== -1 && end !== -1 && end > start) {
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    // A cutoff mid-generation usually still leaves the verdict field intact
    // even when reason trails off unterminated; recover it directly.
    const verdictMatch = /"verdict"\s*:\s*"([a-z-]+)"/.exec(text);
    if (!verdictMatch) return null;
    const reasonMatch = /"reason"\s*:\s*"([^"]*)/.exec(text);
    parsed = { verdict: verdictMatch[1], reason: reasonMatch ? reasonMatch[1] : '' };
  }
  if (!VERIFY_VERDICTS.has(parsed.verdict)) return null;
  const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 500) : '';
  return { verdict: parsed.verdict, reason };
}

// Semantic grading pass on top of the lesson's regex/contains checks. Only
// called once those already pass, so this judges whether the code is
// actually correct rather than merely containing the right keywords.
async function verify({ code, tests, lessonKey, lessonReference, answer, modelHint }) {
  const sdk = require('@qvac/sdk');
  if (typeof sdk.completion !== 'function') {
    throw new Error('@qvac/sdk does not export completion in this build');
  }

  const requestId = newRequestId();
  const modelName = await resolveModel(modelHint);
  const ctxWindow = approxContextWindow(modelName);
  // Target output is one short verdict now, not a whole checklist, so a
  // third of the window covers thinking + answer with less reserved than before.
  const predictBudget = Math.max(250, Math.floor(ctxWindow / 3));

  // Minimum code budget worth sending; below this the request isn't useful.
  const MIN_CODE_BUDGET = 200;
  const maxPromptTokens = Math.max(0, ctxWindow - predictBudget - MIN_CODE_BUDGET);

  // The answer gets first claim on the budget; splitting evenly with the
  // lesson description used to truncate long answers to a couple of import lines.
  const hasLessonRef = typeof lessonReference === 'string' && lessonReference.length > 0;
  const hasAnswer = typeof answer === 'string' && answer.length > 0;
  let lessonContext = null;
  let answerCapped = null;
  if (hasAnswer) {
    const answerShare = Math.min(maxPromptTokens, Math.max(64, Math.ceil(answer.length / 4)));
    answerCapped = answer.slice(0, answerShare * 4);
  } else if (hasLessonRef) {
    const lessonShare = Math.max(64, Math.floor(maxPromptTokens / 2));
    lessonContext = { content: lessonReference.slice(0, lessonShare * 4) };
  }

  let systemPrompt = buildVerifySystemPrompt(lessonKey, lessonContext, tests, answerCapped);
  if (approxTokens(systemPrompt) > maxPromptTokens && answerCapped) {
    // A genuinely large answer: shrink further rather than dropping to null.
    const shrinkTo = Math.max(64, Math.floor(maxPromptTokens * 0.7));
    systemPrompt = buildVerifySystemPrompt(lessonKey, null, tests, answerCapped.slice(0, shrinkTo * 4));
  }
  if (approxTokens(systemPrompt) > maxPromptTokens) {
    // Last resort: nothing fits; grade against the checklist descriptions alone.
    systemPrompt = buildVerifySystemPrompt(lessonKey, null, tests, null);
  }
  const promptTokens = approxTokens(systemPrompt);
  // Headroom matches predictBudget so prompt + response actually fit ctxWindow.
  const codeBudget = Math.max(MIN_CODE_BUDGET, ctxWindow - promptTokens - predictBudget);
  const codeCapped = code.slice(0, codeBudget * 4);

  const history = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `STUDENT CODE:\n${codeCapped}` },
  ];

  const controller = new AbortController();
  inflight.set(requestId, controller);

  // Unlike send(), only the final verdict matters, so deltas are collected
  // silently and emitted once via a dedicated event.
  (async () => {
    const thinkingFilter = createThinkingFilter();
    let assembled = '';
    try {
      const result = sdk.completion({
        modelId: current.modelId,
        history,
        stream: true,
        captureThinking: false,
        signal: controller.signal,
        generationParams: { predict: predictBudget, temp: 0.2 },
      });
      for await (const event of result.events) {
        if (controller.signal.aborted) break;
        if (!event || typeof event !== 'object') continue;
        const type = event.type;
        if ((type === 'contentDelta' || type === 'rawDelta') && typeof event.text === 'string' && event.text.length > 0) {
          assembled += thinkingFilter.push(event.text);
        } else if (type === 'toolError' && typeof event.error === 'string') {
          emitVerifyResult({ requestId, done: true, error: `tool error: ${event.error}`, result: null });
          return;
        }
      }
      assembled += thinkingFilter.flush();
      const parsed = parseVerifyResponse(assembled);
      if (!parsed) {
        emitVerifyResult({
          requestId,
          done: true,
          error: 'The AI reviewer returned an unexpected response. Try Check Answer again.',
          result: null,
        });
        return;
      }
      emitVerifyResult({ requestId, done: true, error: null, result: parsed });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitVerifyResult({ requestId, done: true, error: message, result: null });
    } finally {
      inflight.delete(requestId);
    }
  })();

  return { requestId, modelName };
}

function emitVerifyResult(payload) {
  events.emit('verifyResult', payload);
}

function onVerifyResult(callback) {
  events.on('verifyResult', callback);
  return () => events.off('verifyResult', callback);
}

const SECURITY_VERDICTS = new Set(['clean', 'suspicious', 'malicious']);
// The wire value the model is prompted to return when it found nothing. Named
// here so the checks below read as intent instead of a bare string compare.
const PASSING_VERDICT = 'clean';
const MAX_SECURITY_CONCERNS = 10;
// Ceiling on the review's generation. MAX_SECURITY_CONCERNS summaries plus the
// verdict fit well inside this; the rest was only ever unused headroom.
const SECURITY_PREDICT_CAP = 384;
// Floor for the same, so a small window buys code coverage while the verdict
// keeps enough room to come back parseable.
const SECURITY_PREDICT_FLOOR = 160;
// The chat template wraps every message with role markers the token estimate
// above cannot see. Reserved so a prompt sized to the window still fits it.
const SECURITY_TEMPLATE_OVERHEAD = 64;

// A shape mismatch returns null rather than coercing to "clean", so a parse
// failure never looks like a real verdict.
function parseSecurityResponse(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !SECURITY_VERDICTS.has(parsed.verdict)) return null;
  // The prompt asks for an empty list on a passing verdict and the model
  // answers with "nothing concerning here" anyway, which then printed as a
  // warning next to a run nobody was being warned about.
  if (parsed.verdict === PASSING_VERDICT) return { verdict: parsed.verdict, concerns: [] };
  const rawConcerns = Array.isArray(parsed.concerns) ? parsed.concerns : [];
  const concerns = rawConcerns
    .filter((c) => c && typeof c === 'object' && typeof c.summary === 'string')
    .slice(0, MAX_SECURITY_CONCERNS)
    .map((c) => ({
      summary: c.summary.slice(0, 300),
      snippet: typeof c.snippet === 'string' ? c.snippet.slice(0, 300) : '',
    }));
  return { verdict: parsed.verdict, concerns };
}

// One completion call, parsed to a verdict. Wrapped by securityScan() below,
// and called directly by peer exec-host.cjs via the worker-client.cjs RPC bridge.
async function runSecurityScan({ code, lessonKey, lessonReference, modelHint, timeoutMs, signal }) {
  // Ahead of the model, and ahead of loading one: a file this device already
  // ships has nothing for a review to find, and this answers in microseconds.
  if (isKnownLessonCode(code)) {
    return { modelName: null, matched: true, truncated: false, result: { verdict: PASSING_VERDICT, concerns: [] } };
  }

  const sdk = require('@qvac/sdk');
  if (typeof sdk.completion !== 'function') {
    throw new Error('@qvac/sdk does not export completion in this build');
  }

  // Which phase eats the deadline has never been measured on the host that
  // misses it, and the fixes differ: a slow load wants a smaller model, a slow
  // prompt wants less code, slow generation wants a lower predict cap.
  const startedAt = Date.now();
  const modelName = await resolveModel(modelHint);
  const loadedAt = Date.now();
  const ctxWindow = approxContextWindow(modelName);
  // A verdict is a short JSON object, so half the context was budget the model
  // could spend but never needed. On a CPU-only host that alone was minutes of
  // generation, which is why the review never landed inside its timeout.
  const fits = Math.max(256, ctxWindow - SECURITY_TEMPLATE_OVERHEAD);

  // One window holds all of it, so the parts are budgeted against each other:
  // an independent floor on the code used to push the total past the window and
  // the model read a clipped prompt. Code first, reference on what is left.
  const codeTokens = approxTokens(code);
  let buildPrompt = buildSecuritySystemPrompt;
  let predictBudget = Math.max(
    SECURITY_PREDICT_FLOOR,
    Math.min(SECURITY_PREDICT_CAP, Math.floor(fits / 3)),
  );
  const roomForCode = () => Math.max(0, fits - predictBudget - approxTokens(buildPrompt(lessonKey, null)));

  // Both steps trade something real away, so they only happen when the file
  // would otherwise be cut: a longer answer holds more concerns, and the full
  // instructions describe what to look for in more detail than the short ones.
  if (roomForCode() < codeTokens) predictBudget = SECURITY_PREDICT_FLOOR;
  if (roomForCode() < codeTokens) buildPrompt = buildCompactSecurityPrompt;

  const basePrompt = buildPrompt(lessonKey, null);
  const spare = roomForCode();
  const codeBudget = Math.min(codeTokens, spare);
  // The reference sits under a header the slice below still has to pay for.
  // Measuring it here keeps a later prompt edit from overrunning the window.
  const lessonOverhead = Math.max(
    0,
    approxTokens(buildPrompt(lessonKey, { content: 'x' })) - approxTokens(basePrompt),
  );
  const lessonBudget = Math.max(0, spare - codeBudget - lessonOverhead);

  const lessonContext =
    lessonBudget > 0 && typeof lessonReference === 'string' && lessonReference.length > 0
      ? { content: lessonReference.slice(0, lessonBudget * 4) }
      : null;

  const systemPrompt = buildPrompt(lessonKey, lessonContext);
  const codeCapped = code.slice(0, codeBudget * 4);
  // Silence here read as a whole file to the model, so a verdict on the first
  // half of a lesson came back as confidently clean as one on all of it.
  const truncated = codeCapped.length < code.length;
  const codeMessage = truncated
    ? `STUDENT CODE (first ${codeCapped.length} of ${code.length} bytes; the rest did not fit and was NOT reviewed):\n${codeCapped}`
    : `STUDENT CODE:\n${codeCapped}`;

  // Every preset here is a Qwen3, which reasons by default and spent the whole
  // predict budget inside <think> before reaching the JSON, leaving the filter
  // nothing to strip and the parser nothing to read. `/no_think` is Qwen3's own
  // switch for a direct answer; a model that doesn't know it reads it as text.
  const history = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `${codeMessage}\n/no_think` },
  ];

  const thinkingFilter = createThinkingFilter();
  let assembled = '';
  // The caller's timeout only stops it waiting for a verdict. Without a
  // deadline on the completion itself, a review that misses it keeps
  // generating and competes for CPU with the run it was meant to clear.
  const controller = new AbortController();
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  if (deadline && typeof deadline.unref === 'function') deadline.unref();
  // The RPC bridge cannot carry a signal, so peer exec passes timeoutMs
  // instead; this covers the in-process caller that stops on request.
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  let firstDeltaAt = 0;
  let deltas = 0;
  try {
    const result = sdk.completion({
      modelId: current.modelId,
      history,
      stream: true,
      captureThinking: false,
      signal: controller.signal,
      generationParams: { predict: predictBudget, temp: 0.2 },
    });
    for await (const event of result.events) {
      if (controller.signal.aborted) break;
      if (!event || typeof event !== 'object') continue;
      const type = event.type;
      if ((type === 'contentDelta' || type === 'rawDelta') && typeof event.text === 'string' && event.text.length > 0) {
        if (firstDeltaAt === 0) firstDeltaAt = Date.now();
        deltas += 1;
        assembled += thinkingFilter.push(event.text);
      } else if (type === 'toolError' && typeof event.error === 'string') {
        throw new Error(`tool error: ${event.error}`);
      }
    }
  } finally {
    if (deadline) clearTimeout(deadline);
  }

  const split = () => {
    const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
    const parts = [`model load ${secs(loadedAt - startedAt)}`];
    if (firstDeltaAt === 0) {
      parts.push(`no first token after ${secs(Date.now() - loadedAt)}`);
    } else {
      parts.push(`first token ${secs(firstDeltaAt - loadedAt)}`);
      parts.push(`${deltas} chunks in ${secs(Date.now() - firstDeltaAt)}`);
    }
    return parts.join(', ');
  };

  // Half a verdict is not a verdict: parsing a truncated response could read
  // as clean, so an aborted review has to fail rather than answer.
  if (controller.signal.aborted) {
    throw new Error(`The AI security review ran past its deadline (${split()}).`);
  }
  const coverage = truncated ? `, saw ${codeCapped.length}/${code.length} bytes of code` : '';
  console.log(`[security] reviewed with ${modelName}: ${split()}${coverage}`);
  assembled += thinkingFilter.flush();
  const parsed = parseSecurityResponse(assembled);
  if (!parsed) {
    throw new Error('The AI security reviewer returned an unexpected response.');
  }
  return { modelName, matched: false, truncated, result: evidenced(parsed, codeCapped) };
}

// Shortest quote worth treating as evidence. Below this a model naming a
// common token ("await", "fs") would corroborate anything.
const MIN_CONCERN_QUOTE = 12;

// A model this small reads the prompt's own watch list back as its finding,
// which refused benign lessons in the reviewer's own words. Each concern is
// asked to quote the code it means, so a quote absent from that code is not
// evidence, and a verdict left with no evidence is not a verdict.
function evidenced(parsed, code) {
  if (parsed.verdict === PASSING_VERDICT) return parsed;
  const haystack = normalizeLessonCode(code);
  const concerns = parsed.concerns.filter((concern) => {
    const quote = normalizeLessonCode(concern.snippet);
    return quote.length >= MIN_CONCERN_QUOTE && haystack.includes(quote);
  });
  if (concerns.length > 0) return { verdict: parsed.verdict, concerns };
  console.log(
    `[security] dropped an unevidenced "${parsed.verdict}" verdict:`,
    parsed.concerns.map((c) => c.summary.slice(0, 80)),
  );
  return { verdict: PASSING_VERDICT, concerns: [] };
}

// IPC-facing wrapper mirroring verify(): returns immediately with a
// requestId, the actual verdict arrives once via onSecurityResult.
async function securityScan({ code, lessonKey, lessonReference, modelHint }) {
  const requestId = newRequestId();
  const controller = new AbortController();
  inflight.set(requestId, controller);

  let modelName = current.filename;
  (async () => {
    try {
      const outcome = await runSecurityScan({
        code,
        lessonKey,
        lessonReference,
        modelHint,
        signal: controller.signal,
      });
      modelName = outcome.modelName;
      if (controller.signal.aborted) return;
      emitSecurityResult({ requestId, done: true, error: null, result: outcome.result });
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      emitSecurityResult({ requestId, done: true, error: message, result: null });
    } finally {
      inflight.delete(requestId);
    }
  })();

  return { requestId, modelName };
}

function emitSecurityResult(payload) {
  events.emit('securityResult', payload);
}

function onSecurityResult(callback) {
  events.on('securityResult', callback);
  return () => events.off('securityResult', callback);
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
  verify,
  securityScan,
  // Called by electron/pear-end/worker-client.cjs, which bridges it to the pear-end worker.
  runSecurityScan,
  stop,
  onChunk,
  onVerifyResult,
  onSecurityResult,
  onLoadProgress,
  unload,
  pickDefaultChatModel,
  isChatModelInstalled,
  isChatPreset,
  docsStatus: () => docsStatusFromCache(),
  docsRefresh: async () => {
    const body = await refreshDocs();
    return { ok: !!body, ...docsStatusFromCache() };
  },
  // Exposed for tests.
  _inflight: inflight,
  parseVerifyResponse,
};

function docsStatusFromCache() {
  const { docsStatus } = require('./chat-docs.cjs');
  return docsStatus();
}
