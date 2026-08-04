'use strict';

const test = require('brittle');
const {
  isTeardownNoise,
  TEARDOWN_NAMES,
  TEARDOWN_CODES,
} = require('../../electron/teardown-noise.cjs');

function makeErr(name, code, message, cause) {
  const e = new Error(message);
  if (name) e.name = name;
  if (code !== undefined) e.code = code;
  if (cause !== undefined) Object.defineProperty(e, 'cause', { value: cause });
  return e;
}

test('teardown-noise - null/undefined is noise', (t) => {
  t.is(isTeardownNoise(undefined), true);
  t.is(isTeardownNoise(null), true);
});

test('teardown-noise - WorkerShutdownError and friends are noise', (t) => {
  for (const name of TEARDOWN_NAMES) {
    t.is(isTeardownNoise(makeErr(name, undefined, 'something')), true, name);
  }
});

test('teardown-noise - SDK codes on otherwise generic errors are noise', (t) => {
  for (const code of TEARDOWN_CODES) {
    t.is(
      isTeardownNoise(makeErr('SomeError', code, 'anything goes')),
      true,
      code,
    );
  }
});

test('teardown-noise - transcription / translation / TTS errors are noise', (t) => {
  // Every per-op SDK error that fires after unloadModel gets dropped here.
  const cases = [
    { name: 'TranscriptionFailedError', message: 'Transcription failed: Model whisper-tiny-q4 was unloaded' },
    { name: 'TranslationFailedError', message: 'Translation failed: Model llama was unloaded' },
    { name: 'TextToSpeechFailedError', message: 'TTS failed: Model supertonic was unloaded' },
    { name: 'TextToSpeechStreamFailedError', message: 'stream aborted' },
  ];
  for (const c of cases) {
    t.is(isTeardownNoise(makeErr(c.name, undefined, c.message)), true, c.name);
  }
});

test('teardown-noise - AbortError and DOMException abort are noise', (t) => {
  t.is(isTeardownNoise(makeErr('AbortError', undefined, 'aborted')), true);
  t.is(isTeardownNoise(makeErr('AbortError', 'ABORT_ERR', 'aborted')), true);
  t.is(isTeardownNoise(makeErr('aborterror', undefined, 'lowercased name still matches')), true);
});

test('teardown-noise - generic shutdown-pattern messages are noise', (t) => {
  t.is(isTeardownNoise(makeErr('Custom', 'CUSTOM', 'SDK is shutting down — in-flight RPC call aborted')), true);
  t.is(isTeardownNoise(makeErr('Custom', 'CUSTOM', 'Is shutting down soon')), true);
  t.is(isTeardownNoise(makeErr('Custom', 'CUSTOM', 'Worker exited mid-request (code=143, signal=SIGTERM) — in-flight calls were aborted')), true);
});

test('teardown-noise - real errors are NOT noise', (t) => {
  t.is(isTeardownNoise(makeErr('TypeError', undefined, "Cannot read property 'x' of undefined")), false);
  t.is(isTeardownNoise(makeErr('SyntaxError', undefined, 'Unexpected token (1:3)')), false);
  t.is(isTeardownNoise(makeErr('RangeError', undefined, 'Maximum call stack')), false);
  t.is(isTeardownNoise(new Error('something the user wrote broke')), false);
});

test('teardown-noise - errors with no recognizable shape fall through', (t) => {
  // SDK errors that lack a name and code are NOT classified as teardown by
  // default; they reach the lesson panel as their single-line message.
  const bare = new Error('something specific');
  t.is(isTeardownNoise(bare), false);
});

test('teardown-noise - matches allowlist invariants', (t) => {
  // Drift between runner-process.cjs preamble and this module would mean
  // teardown errors leak. Cross-check the allowlists are non-empty.
  t.ok(TEARDOWN_NAMES.size > 0, 'names list has at least one entry');
  t.ok(TEARDOWN_CODES.size > 0, 'codes list has at least one entry');
});
