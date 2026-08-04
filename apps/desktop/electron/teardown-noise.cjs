'use strict';

// Decide whether an uncaught exception thrown during lesson teardown is
// something the learner can act on, or just shutdown chatter the host should
// swallow so the lesson output panel doesn't turn red on a deliberate Stop.
//
// Voice-assistant loops can throw a "TranscriptionFailedError: Model X unloaded"
// every time the SDK's transcription RPC drains after unloadModel is called.
// The user's lesson only filters WorkerShutdownError / CHANNEL_CLOSED; without
// this filter, those errors would re-emit to stderr via throw err, and the
// panel would fill with red error lines.
//
// The filter matches on name, code, and a small message-substring allowlist
// matching the SDK's known teardown messages. Real errors that don't match
// any rule surface as a single-line message instead of a stack.
//
// IMPORTANT: the allowlists below are mirrored inline in
// electron/runner-process.cjs (the snippet preamble that ships with every
// lesson). When you add a name or code here, update both files and the
// runner-process unit tests; a drift between the two lets teardown errors
// reach the lesson panel.

const TEARDOWN_NAMES = new Set([
  'WorkerShutdownError',
  'WorkerCrashedError',
  'BareRuntimeBinaryNotFoundError',
  'InferenceCancelledError',
  'TranscriptionFailedError',
  'TranslationFailedError',
  'TextToSpeechStreamFailedError',
  'TextToSpeechFailedError',
]);

const TEARDOWN_CODES = new Set([
  'ABORT_ERR',
  'CHANNEL_CLOSED',
  'MODEL_NOT_LOADED',
  'MODEL_WAS_UNLOADED',
  'WORKER_SHUTDOWN',
  'RPC_CONNECTION_FAILED',
]);

const TEARDOWN_MESSAGE_PATTERNS = [
  /\bis shutting down\b/i,
  /\bin-flight rpc\b/i,
  /^Worker exited mid-request\b/i,
];

function isTeardownNoise(err) {
  if (!err) return true;
  const name = (err.name || '').toString();
  const code = (err.code || '').toString();
  if (TEARDOWN_NAMES.has(name)) return true;
  if (TEARDOWN_CODES.has(code)) return true;
  if (/^abort/i.test(name)) return true;
  const message = (err.message || String(err) || '').toString().trim();
  for (const re of TEARDOWN_MESSAGE_PATTERNS) {
    if (re.test(message)) return true;
  }
  return false;
}

module.exports = {
  isTeardownNoise,
  TEARDOWN_NAMES,
  TEARDOWN_CODES,
  TEARDOWN_MESSAGE_PATTERNS,
};
