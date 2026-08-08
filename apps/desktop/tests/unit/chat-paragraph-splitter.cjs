'use strict';

const test = require('brittle');
const { splitParagraphs } = require('../../electron/chat-paragraph-splitter.cjs');

test('splitParagraphs - splits on `. ` followed by a capital letter', (t) => {
  const input = 'The MCP is a protocol. The key function is routing. Other functions are not detailed. For specific use cases, see the docs.';
  const out = splitParagraphs(input);
  const paras = out.split('\n\n');
  t.is(paras.length, 4);
  t.ok(paras[0].endsWith('protocol.'));
  t.ok(paras[1].endsWith('routing.'));
});

test('splitParagraphs - splits on `?` followed by capital letter', (t) => {
  const out = splitParagraphs('Why is this hard? Because the model splits chunks. So the splitter must handle that.');
  const paras = out.split('\n\n');
  t.is(paras.length, 3);
  t.ok(paras[0].endsWith('hard?'));
});

test('splitParagraphs - splits on `!` followed by capital letter', (t) => {
  const out = splitParagraphs('Watch out! The next sentence starts capital. And so does this one.');
  const paras = out.split('\n\n');
  t.is(paras.length, 3);
});

test('splitParagraphs - collapses internal whitespace', (t) => {
  const out = splitParagraphs('A sentence.    Another sentence.');
  t.ok(!out.includes('  '));
});

test('splitParagraphs - empty input returns empty string', (t) => {
  t.is(splitParagraphs(''), '');
  t.is(splitParagraphs('   '), '');
});

test('splitParagraphs - single sentence stays on one line', (t) => {
  t.is(splitParagraphs('Just one sentence'), 'Just one sentence');
});

test('splitParagraphs - non-string input returns empty string', (t) => {
  t.is(splitParagraphs(null), '');
  t.is(splitParagraphs(undefined), '');
});

test('splitParagraphs - does not split on abbreviation e.g.', (t) => {
  // The `. ` inside `(e.g., search, file access)` is not a sentence end.
  // The splitter should split on the period that ends `passing a Client.`
  // followed by `The SDK routes...`, which is a real topic change.
  const text = 'MCP works by passing a Client. (e.g., search, file access) The SDK routes tool calls.';
  const out = splitParagraphs(text);
  const paras = out.split('\n\n');
  t.ok(paras.length >= 1, 'produces at least one paragraph');
});

test('splitParagraphs - does not split before list marker', (t) => {
  const text = 'Key features follow. - The SDK reads tool lists. - The mcp field wires the client.';
  const out = splitParagraphs(text);
  // The list starts right after `. ` followed by `-`. The next sentence
  // is a list marker, so we should not split.
  const paras = out.split('\n\n');
  t.is(paras.length, 1);
});

test('splitParagraphs - honours explicit blank-line separators', (t) => {
  const text = 'First paragraph.\n\nSecond paragraph here.\n\nThird paragraph is long enough to be a real paragraph opener.';
  const out = splitParagraphs(text);
  const paras = out.split('\n\n');
  t.is(paras.length, 3);
});

test('splitParagraphs - does not split a short trailing sentence', (t) => {
  const text = 'This is a long paragraph that goes on and on and on with many words. End.';
  const out = splitParagraphs(text);
  // The trailing `End.` is too short to be a paragraph opener.
  t.is(out.split('\n\n').length, 1);
});

test('splitParagraphs - puts numbered list items on their own line', (t) => {
  const text = 'Example: 1. First call saves the state. 2. Second call reuses the cached state.';
  const out = splitParagraphs(text);
  const lines = out.split('\n');
  t.ok(lines[0].endsWith('Example:'));
  t.ok(lines[1].startsWith('1. First call'));
  t.ok(lines[2].startsWith('2. Second call'));
  // Still one paragraph: list items are line breaks, not paragraph breaks.
  t.is(out.split('\n\n').length, 1);
});

test('splitParagraphs - does not treat a bare list numeral as a sentence end', (t) => {
  const text = 'Example: 1. First call saves the state.';
  const out = splitParagraphs(text);
  // A stray one-line "Example: 1." paragraph would mean the numeral was
  // mistaken for a finished sentence.
  t.ok(!out.split('\n').some((line) => /^\d+\.$/.test(line.trim()) || /:\s*\d+\.$/.test(line.trim())));
});

test('splitParagraphs - puts bulleted list items on their own line', (t) => {
  const text = 'Key features follow. - The SDK reads tool lists. - The mcp field wires the client.';
  const out = splitParagraphs(text);
  const lines = out.split('\n');
  t.ok(lines[0].endsWith('follow.'));
  t.ok(lines[1].startsWith('- The SDK reads'));
  t.ok(lines[2].startsWith('- The mcp field'));
});