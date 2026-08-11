'use strict';

// Cached QVAC documentation the renderer asks the host to fetch when there
// is WiFi. Injected into the chat system prompt so the local model can
// answer SDK questions without hallucinating.
//
// The fetch only runs when the renderer explicitly asks (chat.send with
// `useFullDocs: true`). Cached for DOCS_TTL_MS; bounded by
// DOCS_DISK_MAX_BYTES to keep the prompt small.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

// Bounds the cached raw file, not the prompt (DOCS_PROMPT_MAX_BYTES below
// does that); llms-full.txt is ~1MB as of 2026-08-11, so this leaves headroom.
const DOCS_URL = 'https://docs.qvac.tether.io/llms-full.txt';
const DOCS_TTL_MS = 6 * 60 * 60 * 1000;
const DOCS_DISK_MAX_BYTES = 2 * 1024 * 1024;
const DOCS_PROMPT_MAX_BYTES = 12 * 1024;
const DOCS_TIMEOUT_MS = 8_000;
const DOCS_FETCH_ENABLED = process.env.ACADEMY_CHAT_FETCH_DOCS !== '0';

let cache = {
  body: null,
  expiresAt: 0,
  inflight: null,
  source: 'none',
};

function cacheDir() {
  return path.join(os.homedir(), '.cache', 'tether-academy');
}

async function cacheFile() {
  return path.join(cacheDir(), 'docs-llms-full.txt');
}

async function readCacheFile() {
  try {
    const file = await cacheFile();
    const stat = await fsp.stat(file);
    if (Date.now() - stat.mtimeMs > DOCS_TTL_MS) return null;
    return await fsp.readFile(file, 'utf-8');
  } catch {
    return null;
  }
}

async function writeCacheFile(body) {
  try {
    await fsp.mkdir(cacheDir(), { recursive: true });
    await fsp.writeFile(await cacheFile(), body, 'utf-8');
  } catch {
    // cache-write is best-effort
  }
}

// Uses the global fetch (undici), not node:https: Cloudflare's bot check
// blocks node:https's TLS/HTTP client fingerprint on this host regardless of
// headers sent, but passes undici's.
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('docs fetch timed out')), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) {
      throw new Error(`docs fetch failed with status ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let total = 0;
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > DOCS_DISK_MAX_BYTES) {
        await reader.cancel();
        throw new Error('docs fetch exceeded the size cap');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function refreshDocs() {
  if (!DOCS_FETCH_ENABLED) {
    cache = { body: null, expiresAt: 0, inflight: null, source: 'disabled' };
    return null;
  }
  if (cache.body && Date.now() < cache.expiresAt) {
    return cache.body;
  }
  if (cache.inflight) return cache.inflight;
  cache.inflight = (async () => {
    try {
      const body = await fetchWithTimeout(DOCS_URL, DOCS_TIMEOUT_MS);
      cache = { body, expiresAt: Date.now() + DOCS_TTL_MS, inflight: null, source: 'network' };
      void writeCacheFile(body);
      return body;
    } catch (err) {
      const fromDisk = await readCacheFile();
      if (fromDisk) {
        cache = {
          body: fromDisk,
          expiresAt: Date.now() + DOCS_TTL_MS,
          inflight: null,
          source: 'cache',
        };
        return fromDisk;
      }
      cache = { body: null, expiresAt: 0, inflight: null, source: 'none' };
      console.warn('[chat-docs] fetch failed, no cached copy:', err.message);
      return null;
    }
  })();
  return cache.inflight;
}

function getCachedDocs() {
  if (cache.body && Date.now() < cache.expiresAt) return cache.body;
  return null;
}

function docsStatus() {
  return {
    available: !!getCachedDocs(),
    source: cache.source,
    bytes: cache.body ? Buffer.byteLength(cache.body, 'utf-8') : 0,
    expiresAt: cache.expiresAt,
  };
}

module.exports = { refreshDocs, getCachedDocs, docsStatus, DOCS_URL, DOCS_DISK_MAX_BYTES, DOCS_PROMPT_MAX_BYTES };
