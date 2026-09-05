'use strict';

// Real chunk + embed + vector search via ragIngest/ragSearch, not the
// whole-document prompt-stuffing Ask about a document uses. Each call
// gets its own ephemeral workspace, closed and deleted after.

const crypto = require('node:crypto');
const { ensureModels } = require('../shared/model-fetch.cjs');

const EMBED_PRESET_KEY = 'GTE_LARGE_FP16';
const IDLE_UNLOAD_MS = 20 * 60 * 1000;
// Generous margin under the embedder's 512-token window (roughly 4 chars/token
// for English), sized in characters so it doesn't depend on any tokenizer.
const MAX_CHUNK_CHARS = 1200;

function splitIntoSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// The SDK's own chunker counts chunkSize in splitStrategy units, not
// characters, which let one chunk run to 25000+ tokens on a real document.
function chunkDocument(text) {
  const chunks = [];
  let current = '';
  const flush = () => {
    if (current) {
      chunks.push(current);
      current = '';
    }
  };
  for (const sentence of splitIntoSentences(text)) {
    if (sentence.length > MAX_CHUNK_CHARS) {
      flush();
      for (let i = 0; i < sentence.length; i += MAX_CHUNK_CHARS) chunks.push(sentence.slice(i, i + MAX_CHUNK_CHARS));
      continue;
    }
    if (current && current.length + sentence.length + 1 > MAX_CHUNK_CHARS) flush();
    current = current ? `${current} ${sentence}` : sentence;
  }
  flush();
  return chunks;
}

let current = { modelId: null };
let idleTimer = null;

function clearIdleTimer() {
  if (!idleTimer) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

function touchIdleTimer() {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    unloadEmbedModel().catch((err) => console.warn('[rag] idle unload failed', err && err.message));
  }, IDLE_UNLOAD_MS);
  if (typeof idleTimer.unref === 'function') idleTimer.unref();
}

async function unloadEmbedModel() {
  clearIdleTimer();
  if (!current.modelId) return;
  const modelId = current.modelId;
  const sdk = require('@qvac/sdk');
  if (typeof sdk.unloadModel === 'function') {
    try {
      await sdk.unloadModel({ modelId });
    } catch (err) {
      console.warn('[rag] unload failed', err && err.message);
    }
  }
  current = { modelId: null };
}

async function ensureEmbedModel() {
  if (current.modelId) {
    touchIdleTimer();
    return current.modelId;
  }
  const sdk = require('@qvac/sdk');
  if (typeof sdk.loadModel !== 'function') {
    throw new Error('@qvac/sdk does not export loadModel in this build');
  }
  const modelSrc = sdk[EMBED_PRESET_KEY];
  if (!modelSrc) {
    throw new Error(`@qvac/sdk does not export ${EMBED_PRESET_KEY} in this build`);
  }
  await ensureModels([EMBED_PRESET_KEY], {}).catch(() => {});
  const modelId = await sdk.loadModel({ modelSrc });
  current = { modelId };
  touchIdleTimer();
  return modelId;
}

/** Ingests `documents` into a throwaway workspace, searches `query` against
 *  them, then deletes the workspace. Returns SDK SearchResult[] (id, content, score). */
async function searchDocuments(documents, query, topK) {
  const sdk = require('@qvac/sdk');
  if (typeof sdk.ragIngest !== 'function' || typeof sdk.ragSearch !== 'function') {
    throw new Error('@qvac/sdk does not export ragIngest/ragSearch in this build');
  }
  const modelId = await ensureEmbedModel();
  const workspace = `playground-${crypto.randomUUID()}`;
  try {
    await sdk.ragIngest({
      modelId,
      documents: documents.flatMap(chunkDocument),
      workspace,
      chunk: false,
    });
    return await sdk.ragSearch({ modelId, query, topK: topK || 5, workspace });
  } finally {
    if (typeof sdk.ragCloseWorkspace === 'function') {
      await sdk.ragCloseWorkspace({ workspace, deleteOnClose: true }).catch((err) => {
        console.warn('[rag] workspace cleanup failed', err && err.message);
      });
    }
  }
}

module.exports = { searchDocuments, unloadEmbedModel };
