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

// ~4 pages of an llms.txt and a multi-section answer. The 0.6B preset
// strips docs anyway; this cap applies to 1.7B and up.
const DOCS_URL = 'https://docs.qvac.tether.io/llms-full.txt';
const DOCS_TTL_MS = 6 * 60 * 60 * 1000;
const DOCS_DISK_MAX_BYTES = 320 * 1024;
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

const MAX_DOCS_REDIRECTS = 3;

function fetchWithTimeout(url, timeoutMs, redirectsLeft = MAX_DOCS_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const lib = require('node:https');
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('docs fetch exceeded the redirect limit'));
          return;
        }
        resolve(fetchWithTimeout(new URL(res.headers.location, url).toString(), timeoutMs, redirectsLeft - 1));
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`docs fetch failed with status ${res.statusCode}`));
        return;
      }
      let total = 0;
      const chunks = [];
      res.setEncoding('utf-8');
      res.on('data', (chunk) => {
        total += Buffer.byteLength(chunk, 'utf-8');
        if (total > DOCS_DISK_MAX_BYTES) {
          res.destroy();
          reject(new Error('docs fetch exceeded the size cap'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(chunks.join('')));
      res.on('error', reject);
    });
    req.on('timeout', () => {
      req.destroy(new Error('docs fetch timed out'));
    });
    req.on('error', reject);
  });
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
