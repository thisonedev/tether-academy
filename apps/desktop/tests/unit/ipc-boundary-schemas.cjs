'use strict';

// The three ipcMain.handle calls that used to take a renderer payload and
// check nothing. None had a reachable exploit, since each is covered by a
// second check further in, but a boundary where most handlers validate and a
// few do not is how the next one gets missed.

const test = require('brittle');

// @academy/validation is ESM, so require() cannot load it. Memoised so each
// test can await it independently of run order.
let pending;
const validation = () => (pending ||= import('@academy/validation'));

test('boundary-schemas - modelId stays under the models root', async (t) => {
  const v = await validation();

  t.is(v.modelIdSchema.parse('Qwen3-0.6B-Q4_0.gguf'), 'Qwen3-0.6B-Q4_0.gguf');
  t.is(v.modelIdSchema.parse('abc123/shard-0.gguf'), 'abc123/shard-0.gguf', 'a nested entry');

  t.exception(() => v.modelIdSchema.parse('../../.ssh/id_rsa'), 'traversal');
  t.exception(() => v.modelIdSchema.parse('a/../../etc/passwd'), 'traversal mid-path');
  t.exception(() => v.modelIdSchema.parse('/etc/passwd'), 'absolute');
  t.exception(() => v.modelIdSchema.parse('a\\..\\b'), 'backslash');
  t.exception(() => v.modelIdSchema.parse('a\0b'), 'NUL');
  t.exception(() => v.modelIdSchema.parse('a//b'), 'empty segment');
  t.exception(() => v.modelIdSchema.parse(''), 'empty');
  t.exception(() => v.modelIdSchema.parse(42), 'not a string');
});

// The scrub delay comes from the renderer, so a caller could otherwise park it
// so far out that the pairing code stays on the clipboard for the session.
test('boundary-schemas - the clipboard scrub delay is bounded', async (t) => {
  const v = await validation();

  t.is(v.clipboardCopySchema.parse({ text: 'ABC123' }).scrubAfterMs, v.CLIPBOARD_SCRUB_MS);
  t.is(v.clipboardCopySchema.parse({ text: 'ABC123', scrubAfterMs: 0 }).scrubAfterMs, 0, 'opt out');

  t.exception(() => v.clipboardCopySchema.parse({ text: 'x', scrubAfterMs: 3_600_000 }), 'over the cap');
  t.exception(() => v.clipboardCopySchema.parse({ text: 'x', scrubAfterMs: -1 }), 'negative');
  t.exception(() => v.clipboardCopySchema.parse({ text: '' }), 'empty text');
  t.exception(() => v.clipboardCopySchema.parse({ text: 'x'.repeat(8193) }), 'over the length cap');
});

test('boundary-schemas - a worker specifier has to be a bounded string', async (t) => {
  const v = await validation();

  t.is(v.workerSpecifierSchema.parse('/workers/main.js'), '/workers/main.js');
  t.exception(() => v.workerSpecifierSchema.parse(''), 'empty');
  t.exception(() => v.workerSpecifierSchema.parse('x'.repeat(257)), 'over the cap');
  t.exception(() => v.workerSpecifierSchema.parse({ toString: () => '/workers/main.js' }), 'not a string');
});

test('boundary-schemas - a worker IPC frame is bytes or text, within a cap', async (t) => {
  const v = await validation();
  const { MAX_WORKER_IPC_BYTES } = v;

  t.is(v.workerIpcDataSchema.parse('hello'), 'hello');
  t.alike(v.workerIpcDataSchema.parse(new Uint8Array([1, 2, 3])), new Uint8Array([1, 2, 3]));
  t.ok(v.workerIpcDataSchema.parse(Buffer.from('hi')), 'a Buffer is what Electron actually delivers');

  t.exception(() => v.workerIpcDataSchema.parse('x'.repeat(MAX_WORKER_IPC_BYTES + 1)), 'text over the cap');
  t.exception(
    () => v.workerIpcDataSchema.parse(new Uint8Array(MAX_WORKER_IPC_BYTES + 1)),
    'bytes over the cap',
  );
  t.exception(() => v.workerIpcDataSchema.parse({ length: 3 }), 'not bytes or text');
  t.exception(() => v.workerIpcDataSchema.parse(null), 'null');
});
