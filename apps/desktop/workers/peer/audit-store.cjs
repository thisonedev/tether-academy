// Append-only audit trail: one JSON object per line, mode 0600, a fixed number
// of generations kept on disk, then age eviction. Seeds the renderer's
// in-memory ring at startup.
'use strict';

const fs = require('fs');
const path = require('path');
const { restrictToOwnerWindows } = require('../sandbox/capabilities.cjs');

const AUDIT_FILE = 'peer-audit.jsonl';
const AUDIT_MODE = 0o600;
// Bytes, not entries: a row can vary a lot in size.
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const KEEP_GENERATIONS = 3;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Lazy: created on the first append, never on open.
let _stream = null;
let _path = null;
let _bytes = 0;

function auditPath(stateDir) {
  return path.join(stateDir, AUDIT_FILE);
}

function openStream(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const exists = fs.existsSync(filePath);
  if (!exists) {
    // Create with mode 0600; later opens with 'a' preserve the inode's mode.
    fs.writeFileSync(filePath, '', { mode: 0o600 });
    if (process.platform === 'win32') restrictToOwnerWindows(filePath);
  }
  return fs.openSync(filePath, 'a');
}

function readBytesSafe(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function ensureStream(filePath) {
  if (_stream && _path === filePath) return _stream;
  if (_stream) {
    try { fs.closeSync(_stream.fd); } catch { /* already gone */ }
  }
  _path = filePath;
  _bytes = readBytesSafe(filePath);
  _stream = {
    fd: openStream(filePath),
    path: filePath,
  };
  return _stream;
}

function append(entry) {
  if (!_path) {
    // Not init()'d; index.cjs's in-memory ring still records the entry.
    return false;
  }
  const stream = ensureStream(_path);
  let line;
  try {
    line = JSON.stringify(entry) + '\n';
  } catch {
    // Non-serialisable entry; drop rather than crash a pairing.
    return false;
  }
  try {
    fs.writeSync(stream.fd, line);
    _bytes += Buffer.byteLength(line, 'utf8');
    if (_bytes >= MAX_FILE_BYTES) {
      rotate();
    }
    return true;
  } catch (err) {
    // Never take down a pairing over a disk error; the in-memory ring still has the entry.
    console.warn('[audit-store] append failed:', err?.message ?? err);
    return false;
  }
}

// Up to n most-recent entries, oldest first, across active + archived generations.
function readTail(n = 1000) {
  if (!_path) return [];
  const tails = [];
  for (let i = 0; i < KEEP_GENERATIONS; i++) {
    const filePath = i === 0 ? _path : `${_path}.${i}`;
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[audit-store] readTail ${filePath} failed:`, err?.message ?? err);
      }
      continue;
    }
    const lines = raw.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const entries = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // A truncated or corrupt line: skip rather than refuse the rest.
      }
    }
    tails.push(entries);
  }
  const combined = [];
  for (const fileEntries of tails) {
    const remaining = n - combined.length;
    if (remaining <= 0) break;
    const take = fileEntries.slice(-remaining);
    combined.push(...take);
  }
  return combined;
}

// Close, rename active -> .1, shift older generations up, drop the oldest.
function rotate() {
  if (!_path) return;
  const stream = _stream;
  const currentPath = _path;
  try {
    if (stream) fs.closeSync(stream.fd);
  } catch {
    // ignore
  }
  _stream = null;

  // Drop the generation the upcoming shift would push past the cap.
  const overflow = `${currentPath}.${KEEP_GENERATIONS - 1}`;
  try {
    if (fs.existsSync(overflow)) fs.rmSync(overflow, { force: true });
  } catch (err) {
    console.warn(`[audit-store] evict ${overflow} failed:`, err?.message ?? err);
  }

  for (let i = KEEP_GENERATIONS - 2; i >= 1; i--) {
    const newer = `${currentPath}.${i}`;
    const older = `${currentPath}.${i + 1}`;
    try {
      if (fs.existsSync(newer)) fs.renameSync(newer, older);
    } catch (err) {
      console.warn(`[audit-store] shift ${newer} -> ${older} failed:`, err?.message ?? err);
    }
  }

  try {
    if (fs.existsSync(currentPath)) fs.renameSync(currentPath, `${currentPath}.1`);
  } catch (err) {
    console.warn('[audit-store] rotate active failed:', err?.message ?? err);
  }

  // Age eviction on the now-oldest kept generation.
  const oldest = `${currentPath}.${KEEP_GENERATIONS - 1}`;
  try {
    const st = fs.statSync(oldest);
    if (Date.now() - st.mtimeMs > MAX_AGE_MS) {
      fs.rmSync(oldest, { force: true });
    }
  } catch {
    // absent or unreadable; nothing to evict
  }

  try {
    _stream = { fd: openStream(currentPath), path: currentPath };
    _path = currentPath;
    _bytes = 0;
  } catch (err) {
    console.warn('[audit-store] reopen after rotate failed:', err?.message ?? err);
  }
}

// A UI clear wipes the in-memory ring only; the durable record gets the clear appended as an event.
function recordClear(reason = 'clear-audit', removedCount = 0) {
  append({
    type: 'peer:audit:cleared',
    timestamp: Date.now(),
    reason,
    removed: removedCount,
  });
}

function close() {
  if (_stream) {
    try { fs.closeSync(_stream.fd); } catch { /* already gone */ }
    _stream = null;
  }
  _path = null;
}

function init(filePath) {
  if (typeof filePath !== 'string' || !filePath) {
    throw new Error('audit-store.init: filePath is required');
  }
  close();
  _path = filePath;
  ensureStream(filePath);
}

module.exports = {
  init,
  append,
  readTail,
  rotate,
  recordClear,
  close,
  AUDIT_FILE,
  AUDIT_MODE,
  MAX_FILE_BYTES,
  KEEP_GENERATIONS,
  MAX_AGE_MS,
};