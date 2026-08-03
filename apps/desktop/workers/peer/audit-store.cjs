// Append-only audit trail for the peer worker. One JSON object per line,
// mode 0600, a fixed number of generations kept on disk, then age eviction.
// The renderer's ring still reads from an in-memory array; this file is the
// durable record and seeds the ring at startup so post-restart forensics
// still find entries.
//
// The path comes in through init(), resolved by main against
// app.getPath('userData'), so the peer worker does not need the Electron
// or sandbox modules to find it.

'use strict';

const fs = require('fs');
const path = require('path');

const AUDIT_FILE = 'peer-audit.jsonl';
const AUDIT_MODE = 0o600;
// Bytes, not entries: a row with a long message or many discovery keys can be
// large, so size is the budget that matters.
const MAX_FILE_BYTES = 4 * 1024 * 1024;
// Keep this many completed generations around before age eviction.
const KEEP_GENERATIONS = 3;
// Drop generations older than this when rotation runs.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// One per file name. Lazy: created on the first append, never on open.
let _stream = null;
let _path = null;
let _bytes = 0;
let _rotationInFlight = null;

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
  }
  return fs.openSync(filePath, 'a');
}

// Try to learn the current size without stat per append. The file may not
// exist; the first append creates it.
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
    // Caller did not init() with a path. The audit event is dropped, but the
    // in-memory ring still records it; see index.cjs.
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
      // Coalesce rotations: only one in flight at a time.
      if (!_rotationInFlight) _rotationInFlight = rotate();
    }
    return true;
  } catch (err) {
    // Read-only disk, full disk, file descriptor issue: never take down a
    // pairing. The in-memory ring still has the entry.
    console.warn('[audit-store] append failed:', err?.message ?? err);
    return false;
  }
}

// Returns up to n most-recent entries as an array, oldest first. Walks the
// generations from newest (active) back through .1, .2, ... so a record
// older than the active file but still in an archive is reachable.
function readTail(n = 1000) {
  if (!_path) return [];
  // Walk newest -> oldest. Per file, parse all entries and keep only the
  // tail; concatenating those gives the most recent n across all generations.
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
  // Most recent: take the last n of [active tail, .1 tail, .2 tail, ...].
  // active comes first, so its tail fills the result before we reach older
  // generations.
  const combined = [];
  for (const fileEntries of tails) {
    const remaining = n - combined.length;
    if (remaining <= 0) break;
    // Take the most recent `remaining` from this file.
    const take = fileEntries.slice(-remaining);
    combined.push(...take);
  }
  return combined;
}

// Rotate the active file: close, rename active -> .1, shift older generations
// up, drop the oldest to keep the total at KEEP_GENERATIONS files
// (active + (KEEP_GENERATIONS - 1) archives).
async function rotate() {
  if (!_path) return;
  const stream = _stream;
  const currentPath = _path;
  try {
    if (stream) fs.closeSync(stream.fd);
  } catch {
    // ignore
  }
  _stream = null;

  // Drop the generation that would be pushed past the cap by the upcoming
  // shift. After this, valid generations are .1 .. .(KEEP-2).
  const overflow = `${currentPath}.${KEEP_GENERATIONS - 1}`;
  try {
    if (fs.existsSync(overflow)) fs.rmSync(overflow, { force: true });
  } catch (err) {
    console.warn(`[audit-store] evict ${overflow} failed:`, err?.message ?? err);
  }

  // Shift up: .(N-2) -> .(N-1), ..., .1 -> .2.
  for (let i = KEEP_GENERATIONS - 2; i >= 1; i--) {
    const newer = `${currentPath}.${i}`;
    const older = `${currentPath}.${i + 1}`;
    try {
      if (fs.existsSync(newer)) fs.renameSync(newer, older);
    } catch (err) {
      console.warn(`[audit-store] shift ${newer} -> ${older} failed:`, err?.message ?? err);
    }
  }

  // active -> .1, fresh active.
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

  // Reopen against the same path; ensureStream() will create a fresh file.
  try {
    _stream = { fd: openStream(currentPath), path: currentPath };
    _path = currentPath;
    _bytes = 0;
  } catch (err) {
    console.warn('[audit-store] reopen after rotate failed:', err?.message ?? err);
  }
  _rotationInFlight = null;
}

// Manual clear by the UI clears the in-memory ring only; the durable record
// remains, with the clear itself appended as an event so the post-incident
// view shows what was wiped.
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