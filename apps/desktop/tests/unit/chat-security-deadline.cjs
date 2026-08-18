// timeoutMs has to reach the completion itself, not just the caller waiting on
// it. See runSecurityScan for what an unbounded review costs.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const test = require('brittle');

// Same technique as chat-dedupe: chat.cjs reads os.homedir() at lookup time.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-deadline-test-'));
os.homedir = function stubbedHomedir() { return path.join(tmpRoot, 'fakehome'); };

const chatPath = require.resolve('../../electron/chat.cjs');
const sdkPath = require.resolve('@qvac/sdk');

// Never ends on its own, like a review that outruns its deadline.
function endlessCompletion(seen) {
  return ({ signal }) => {
    seen.signal = signal;
    return {
      events: (async function* stream() {
        for (;;) {
          yield { type: 'contentDelta', text: '{' };
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })(),
    };
  };
}

function freshChat(seen) {
  delete require.cache[sdkPath];
  delete require.cache[chatPath];
  const stub = {
    QWEN3_600M_INST_Q4: { name: 'Qwen3-0.6B-Q4_0' },
    loadModel: async () => 'model-1',
    unloadModel: async () => undefined,
    getLoadedModelInfo: async () => { throw new Error('not configured in this test'); },
    completion: endlessCompletion(seen),
  };
  require.cache[sdkPath] = { exports: stub, id: sdkPath, filename: sdkPath, loaded: true, children: [], paths: [] };
  return require(chatPath);
}

test('chat-security-deadline - a review past timeoutMs aborts instead of generating on', async (t) => {
  const seen = {};
  const chat = freshChat(seen);
  await chat.load('Qwen3-0.6B-Q4_0.gguf');

  const started = Date.now();
  await t.exception(
    () => chat.runSecurityScan({
      code: 'console.log(1)',
      lessonKey: null,
      lessonReference: null,
      modelHint: undefined,
      timeoutMs: 60,
    }),
    /deadline/,
    'refuses to answer from a truncated review',
  );

  t.ok(seen.signal, 'the completion was given a signal to abort on');
  t.ok(seen.signal.aborted, 'and that signal fired');
  t.ok(Date.now() - started < 5_000, 'returned on the deadline, not when the stream ended');
});
