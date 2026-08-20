'use strict';

// A truncated leftover and a download still running are both short, and only
// one of them should be swept. Deleting the live one ends in ENOENT on a file
// the log has already called complete.

const test = require('brittle');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ACTIVE_WRITE_MS } = require('../../electron/models.cjs');

test('prune - the window is long enough to cover a slow write', (t) => {
  t.ok(ACTIVE_WRITE_MS >= 30_000, 'a stalling download still counts as active for a while');
});

// Mirrors the guard in pruneIncompleteDownloads against a real file's mtime,
// since the sweep itself reads the user's models directory.
test('prune - a file touched a moment ago is left alone', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'partial.gguf');
  fs.writeFileSync(file, Buffer.alloc(16));

  const now = Date.now();
  const fresh = fs.statSync(file).mtimeMs;
  t.ok(now - fresh < ACTIVE_WRITE_MS, 'a file being written reads as active');

  const old = now - ACTIVE_WRITE_MS - 1;
  fs.utimesSync(file, new Date(old), new Date(old));
  const stale = fs.statSync(file).mtimeMs;
  t.absent(now - stale < ACTIVE_WRITE_MS, 'one left behind by an old run does not');
});
