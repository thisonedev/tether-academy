'use strict';

// Durable audit trail. The renderer reads the in-memory ring; this file is
// the durable record and seeds the ring on startup so the post-restart view
// is honest about what the previous run did.

const test = require('brittle');
const fs = require('node:fs');
const path = require('node:path');

const auditStore = require('../../workers/peer/audit-store.cjs');
const { tmpDir } = require('../helpers/index.cjs');

function makeFile(t) {
  const dir = tmpDir(t, 'audit-store');
  const file = path.join(dir, 'peer-audit.jsonl');
  return { dir, file };
}

test('audit-store - append writes one JSON object per line, mode 0600', (t) => {
  const { file } = makeFile(t);
  auditStore.init(file);
  auditStore.append({ type: 'peer:pair', timestamp: 1, foo: 'bar' });
  auditStore.append({ type: 'peer:drop', timestamp: 2 });
  // close() flushes the fd so the bytes are on disk for stat.
  auditStore.close();

  const buf = fs.readFileSync(file);
  const lines = buf.toString('utf8').split('\n').filter(Boolean);
  t.is(lines.length, 2);
  t.alike(JSON.parse(lines[0]), { type: 'peer:pair', timestamp: 1, foo: 'bar' });
  t.alike(JSON.parse(lines[1]), { type: 'peer:drop', timestamp: 2 });
  t.is(fs.statSync(file).mode & 0o777, 0o600, 'mode 0600');
});

test('audit-store - readTail returns the most recent n entries', (t) => {
  const { file } = makeFile(t);
  auditStore.init(file);
  for (let i = 0; i < 10; i++) {
    auditStore.append({ type: 'e', timestamp: i });
  }
  auditStore.close();

  auditStore.init(file);
  const tail = auditStore.readTail(3);
  t.is(tail.length, 3);
  t.is(tail[0].timestamp, 7);
  t.is(tail[2].timestamp, 9);
  auditStore.close();
});

test('audit-store - re-init seeds the ring from the file', (t) => {
  const { file } = makeFile(t);
  auditStore.init(file);
  auditStore.append({ type: 'first', timestamp: 100 });
  auditStore.append({ type: 'second', timestamp: 200 });
  auditStore.close();

  // Re-open as if the worker just started up.
  auditStore.init(file);
  const tail = auditStore.readTail(100);
  t.is(tail.length, 2, 'both entries survive close+reopen');
  t.is(tail[0].type, 'first');
  t.is(tail[1].type, 'second');
  auditStore.close();
});

test('audit-store - rotation shifts generations and caps at KEEP_GENERATIONS', async (t) => {
  const { dir, file } = makeFile(t);
  auditStore.init(file);
  // Smaller-than-default test budget: rewrite MAX_FILE_BYTES to a known
  // small value so the test does not have to write 4 MiB.
  const smallBudget = 256;
  // Force a known size: write enough lines to exceed the budget, then rotate.
  for (let i = 0; i < 50; i++) {
    auditStore.append({ type: 'e', timestamp: i, payload: 'x'.repeat(20) });
  }
  // Force rotation by calling rotate() directly so we do not depend on the
  // internal size threshold.
  await auditStore.rotate();
  // Write more so .1 also gets created on the next rotate.
  for (let i = 0; i < 50; i++) {
    auditStore.append({ type: 'f', timestamp: i, payload: 'x'.repeat(20) });
  }
  await auditStore.rotate();
  await auditStore.rotate();
  await auditStore.rotate();

  // Active file plus generations .1 and .2; .3 should not exist.
  const files = fs.readdirSync(dir).filter((n) => n.startsWith('peer-audit'));
  t.ok(files.includes('peer-audit.jsonl'), 'active file present');
  t.ok(files.includes('peer-audit.jsonl.1'), 'first generation present');
  t.ok(files.includes('peer-audit.jsonl.2'), 'second generation present');
  t.absent(files.includes('peer-audit.jsonl.3'), 'capped at KEEP_GENERATIONS');

  auditStore.close();
});

test('audit-store - rotation past the second threshold writes a third generation', (t) => {
  const { dir, file } = makeFile(t);
  auditStore.init(file);
  // 4 MiB cap. Each line is 16 KiB by byteLength even though the file
  // compresses below that on disk; 4 MiB / 16 KiB = 256 lines per rotation.
  // Three 200-line passes trip the cap twice, producing .1 and .2.
  const line = 'x'.repeat(16 * 1024);
  for (let i = 0; i < 200; i += 1) auditStore.append({ type: 'a', i, payload: line });
  for (let i = 0; i < 200; i += 1) auditStore.append({ type: 'b', i, payload: line });
  for (let i = 0; i < 400; i += 1) auditStore.append({ type: 'c', i, payload: line });
  auditStore.close();

  const files = fs.readdirSync(dir).filter((n) => n.startsWith('peer-audit'));
  t.ok(files.includes('peer-audit.jsonl'), 'active file present');
  t.ok(files.includes('peer-audit.jsonl.1'), 'first generation present');
  t.ok(files.includes('peer-audit.jsonl.2'), 'second generation present');
  // Active is the third file. Without the fix it grew without bound past
  // 4 MiB (the latch latched on first use).
  const activeSize = fs.statSync(file).size;
  t.ok(activeSize < 4 * 1024 * 1024, 'active file is bounded by the cap');
});

test('audit-store - recordClear appends a clear event before the ring wipes', (t) => {
  const { file } = makeFile(t);
  auditStore.init(file);
  auditStore.append({ type: 'pre-clear', timestamp: 1 });
  auditStore.recordClear('clear-audit', 1);
  auditStore.close();

  // Re-init the path so readTail knows where to read.
  auditStore.init(file);
  const tail = auditStore.readTail(10);
  t.is(tail.length, 2);
  t.is(tail[1].type, 'peer:audit:cleared');
  t.is(tail[1].reason, 'clear-audit');
  t.is(tail[1].removed, 1);
  auditStore.close();
});

test('audit-store - corrupt lines are skipped on read', (t) => {
  const { file } = makeFile(t);
  fs.writeFileSync(
    file,
    '{"type":"good","timestamp":1}\nthis is not json\n{"type":"also-good","timestamp":2}\n',
    { mode: 0o600 },
  );
  auditStore.init(file);
  const tail = auditStore.readTail(10);
  t.is(tail.length, 2, 'the bad line is skipped, the good ones kept');
  t.is(tail[0].type, 'good');
  t.is(tail[1].type, 'also-good');
  auditStore.close();
});

test('audit-store - append returns false when not initialised, no throw', (t) => {
  // No init() call: a peer that boots without an audit path silently drops
  // writes rather than crashing a pairing.
  auditStore.close();
  t.is(auditStore.append({ type: 'orphan' }), false);
});