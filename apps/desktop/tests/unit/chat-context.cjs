'use strict';

const test = require('brittle');
const {
  buildSystemPrompt,
  trimLessonContext,
  trimDocs,
  MAX_LESSON_CONTEXT_BYTES,
  MAX_DOCS_PROMPT_BYTES,
} = require('../../electron/chat-context.cjs');

test('chat-context - the lesson reference is hard-capped', (t) => {
  t.ok(MAX_LESSON_CONTEXT_BYTES > 0);
  t.ok(MAX_LESSON_CONTEXT_BYTES <= 32 * 1024, 'lesson reference fits in a small context window');
  const big = 'x'.repeat(MAX_LESSON_CONTEXT_BYTES * 2);
  const out = trimLessonContext({ content: big });
  // The trim is approximate; a small label prefix is fine, but it must not
  // exceed the cap by more than a label-sized margin.
  t.ok(out.length <= MAX_LESSON_CONTEXT_BYTES + 32, 'trimmed reference respects the cap');
});

test('chat-context - the docs are hard-capped', (t) => {
  t.ok(MAX_DOCS_PROMPT_BYTES > 0);
  t.ok(MAX_DOCS_PROMPT_BYTES <= 32 * 1024, 'docs fit on 1.7B and up');
  const big = 'y'.repeat(MAX_DOCS_PROMPT_BYTES * 2);
  const out = trimDocs(big);
  t.ok(out.length <= MAX_DOCS_PROMPT_BYTES, 'trimmed docs respect the cap');
});

test('chat-context - the prompt stays under the 0.6B context window', (t) => {
  // The 0.6B Qwen preset has a 1024-token window. With a 0.6B model we
  // strip the lesson reference and the docs in chat.cjs; the bare prompt
  // itself must still fit comfortably under that limit.
  const prompt = buildSystemPrompt(
    { chapter: 'text-generation', lesson: 'mcp' },
    null,
    null,
  );
  t.ok(prompt.length < 1024, 'bare prompt fits in < 1 KiB');
  t.ok(Math.ceil(prompt.length / 4) < 256, 'bare prompt fits in < 256 tokens');
});

test('chat-context - the prompt tells the model to refuse typo chiding', (t) => {
  const prompt = buildSystemPrompt(
    { chapter: 'text-generation', lesson: 'mcp' },
    { content: 'use npx -y @oevortex/ddg_search' },
    null,
  );
  t.ok(/ignore typos/i.test(prompt), 'instructs the model to ignore typos');
  t.ok(/do not invent/i.test(prompt), 'instructs the model not to invent APIs');
  t.ok(/do not mention or correct spelling/i.test(prompt), 'instructs the model not to chide spelling');
});
