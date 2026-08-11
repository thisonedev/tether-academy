'use strict';

const test = require('brittle');
const { createMarkdownStripper } = require('../../electron/chat-strip-markdown.cjs');

test('stripMarkdown - drops bold delimiters and keeps inner text', (t) => {
  const strip = createMarkdownStripper();
  const out = strip.push('**any** external tool or service as a client');
  t.is(out, 'any external tool or service as a client');
  t.is(strip.flush(), '');
});

test('stripMarkdown - drops inline-code backticks', (t) => {
  const strip = createMarkdownStripper();
  const out = strip.push('Use `npx -y @oevortex/ddg_search`');
  t.is(out, 'Use npx -y @oevortex/ddg_search');
});

test('stripMarkdown - drops fenced code blocks', (t) => {
  const strip = createMarkdownStripper();
  const out = strip.push('```\nconst x = 1;\n```');
  t.is(out, 'const x = 1;');
});

test('stripMarkdown - holds opener across chunks', (t) => {
  const strip = createMarkdownStripper();
  // First chunk ends with `**`. The stripper holds it.
  t.is(strip.push('Hello **du'), 'Hello ');
  // Next chunk has the closer; inner text is emitted.
  t.is(strip.push('ck**'), 'duck');
  t.is(strip.flush(), '');
});

test('stripMarkdown - drops heading hashes', (t) => {
  const strip = createMarkdownStripper();
  t.is(strip.push('## Heading\nBody'), 'Heading\nBody');
});

test('stripMarkdown - drops bullet markers', (t) => {
  const strip = createMarkdownStripper();
  t.is(strip.push('- one\n- two\n- three'), 'one\ntwo\nthree');
});

test('stripMarkdown - drops numbered list markers', (t) => {
  const strip = createMarkdownStripper();
  t.is(strip.push('1. one\n2. two\n3. three'), 'one\ntwo\nthree');
});

test('stripMarkdown - drops italic delimiters', (t) => {
  const strip = createMarkdownStripper();
  t.is(strip.push('This is *italic* text'), 'This is italic text');
});

test('stripMarkdown - passes through plain text', (t) => {
  const strip = createMarkdownStripper();
  t.is(strip.push('Just plain text.'), 'Just plain text.');
});

test('stripMarkdown - bold opener broken across chunks is still stripped', (t) => {
  // The model streamed `**Client Integration` then `**: Passing`. The first
  // chunk ends with a single `*` (because the tokenizer split between the
  // two `*`). The stripper joins the next chunk and finds the matching `**`.
  const strip = createMarkdownStripper();
  t.is(strip.push('2. **Client Integration'), '');
  t.is(strip.push('**: Passing'), 'Client Integration: Passing');
  t.is(strip.flush(), '');
});

test('stripMarkdown - flush emits held text when closer never arrives', (t) => {
  const strip = createMarkdownStripper();
  strip.push('Hello **unclosed');
  // Closer never came. Flush emits the held text as visible characters.
  t.is(strip.flush(), '**unclosed');
});

test('stripMarkdown - unpaired dash splits into a new, capitalized sentence', (t) => {
  const strip = createMarkdownStripper();
  t.is(strip.push("Just drop a line — I'm all ears!"), "Just drop a line. I'm all ears!");
  const strip2 = createMarkdownStripper();
  t.is(strip2.push('Here is the plan — start small.'), 'Here is the plan. Start small.');
});

test('stripMarkdown - unpaired dash always gets exactly one space after the period', (t) => {
  const strip = createMarkdownStripper();
  t.is(
    strip.push("Drop a line if you're stuck —or if you want to dive into something else."),
    "Drop a line if you're stuck. Or if you want to dive into something else.",
  );
});

test('stripMarkdown - paired dashes drop the whole aside, not just the dashes', (t) => {
  const strip = createMarkdownStripper();
  t.is(
    strip.push("the code that would produce output — the part these checks don't cover — is still missing"),
    'the code that would produce output is still missing',
  );
});

test('stripMarkdown - a dash with no surrounding space is a range, not a clause break', (t) => {
  const strip = createMarkdownStripper();
  t.is(strip.push('ages 10–20 are fine'), 'ages 10-20 are fine');
});

test('stripMarkdown - en dash resolves the same way as em dash', (t) => {
  const strip = createMarkdownStripper();
  const out = strip.push('word – word.') + strip.flush();
  t.is(out, 'word. Word.');
});

test('stripMarkdown - a dash still unresolved at flush gets a forced decision, never leaks raw', (t) => {
  const strip = createMarkdownStripper();
  const first = strip.push('word ');
  const second = strip.push('— more words');
  const out = first + second + strip.flush();
  t.absent(out.includes('—') || out.includes('–'), 'no raw dash character survives');
});

test('stripMarkdown - chunk boundary right before the dash still gets exactly one space', (t) => {
  const strip = createMarkdownStripper();
  const out =
    strip.push('why TypeScript developers never get lost ') +
    strip.push('— they always use switch statements.') +
    strip.flush();
  t.is(out, 'why TypeScript developers never get lost. They always use switch statements.');
});

test('stripMarkdown - chunk boundary before an unresolved dash still gets exactly one space', (t) => {
  const strip = createMarkdownStripper();
  const out = strip.push('word ') + strip.push('— more words') + strip.flush();
  t.is(out, 'word. More words');
});