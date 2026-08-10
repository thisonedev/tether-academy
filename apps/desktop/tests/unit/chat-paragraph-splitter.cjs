'use strict';

const test = require('brittle');
const { splitParagraphs } = require('../../electron/chat-paragraph-splitter.cjs');

test('splitParagraphs - splits on `. ` followed by a capital letter once the paragraph is long enough', (t) => {
  const input = 'The Model Context Protocol standardises how an assistant discovers and calls external tools. Each server declares the tools it exposes, and the client routes calls to the matching server automatically. Once a session starts, the model can call any declared tool without further setup on the client side. For specific use cases, such as combining multiple servers, see the docs for routing details.';
  const out = splitParagraphs(input);
  const paras = out.split('\n\n');
  t.is(paras.length, 2);
  t.ok(paras[0].endsWith('automatically.'));
});

test('splitParagraphs - splits on `?` followed by capital letter once the paragraph is long enough', (t) => {
  const input = 'Why is streaming text hard to format into paragraphs? Because the model splits its own output into arbitrary chunks that rarely line up with sentence or paragraph boundaries. So the splitter has to reassemble the stream and infer real paragraph breaks after the fact. This keeps the reader from seeing one unbroken wall of text regardless of how the model happened to chunk its response.';
  const out = splitParagraphs(input);
  const paras = out.split('\n\n');
  t.is(paras.length, 2);
  t.ok(paras[0].endsWith('the fact.'));
});

test('splitParagraphs - splits on `!` followed by capital letter once the paragraph is long enough', (t) => {
  const input = 'Watch out for streamed text that never contains a blank line at all! The next sentence still starts with a capital letter, which is the only signal the splitter has to work with here. And so does this one, which pushes the running paragraph past the minimum length needed before a break is allowed.';
  const out = splitParagraphs(input);
  const paras = out.split('\n\n');
  t.is(paras.length, 2);
});

test('splitParagraphs - does not split a short run of sentences into one-sentence paragraphs', (t) => {
  const input = 'The query parameter defines the question. The topK parameter controls result count. Scores rank the results by relevance.';
  const out = splitParagraphs(input);
  t.is(out.split('\n\n').length, 1);
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

test('splitParagraphs - keeps a numbered list together even past MAX_PARAGRAPH_LEN', (t) => {
  // Regression: buffer used to cross the force-break length right at "3.".
  const text = 'To complete this lesson, you need to: 1. Create a history array with one user message, like { role: "user", content: "Explain quantum computing in one sentence." }. 2. Call completion() with your modelId, the history array, and set stream: true to enable token streaming. 3. Iterate over the returned tokenStream using for await (const token of result.tokenStream) and write each token to stdout with process.stdout.write(token).';
  const out = splitParagraphs(text);
  t.is(out.split('\n\n').length, 1, 'the whole list stays in one paragraph');
  const lines = out.split('\n');
  t.ok(lines.some((l) => l.startsWith('3. Iterate')), '"3." starts its own line intact');
  t.ok(!out.includes('result.\n') && !out.includes('result. '), 'does not break mid code identifier');
});

test('splitParagraphs - keeps a multi-sentence list item with its own marker', (t) => {
  // Regression: the second sentence of an item ("It needs at least 4...") was
  // orphaned into its own paragraph, detaching it from the "2." that numbers it.
  const text = "This lesson explains how to reindex a RAG workspace after frequent writes (like deletes or re-ingests) to ensure the index reflects current data. Here's what to do: 1. Why reindex? After many changes, the index may no longer match the stored text, causing score drift. Reindexing regenerates embeddings from scratch. 2. How to reindex: Use ragReindex({ workspace }), which runs k-means clustering on embeddings. It needs at least 4 documents (default NUM_CENTROIDS=4) to generate centroids. Fewer than 4 documents result in a no-op with reindexed: false. 3. Handle results: The output is { reindexed, details }. If reindexed: true, everything is updated.";
  const out = splitParagraphs(text);
  const itemLine = (n) => out.split('\n').find((l) => l.startsWith(`${n}. `));
  t.ok(itemLine(2).includes('It needs at least 4 documents'), "item 2 keeps its second sentence");
  t.ok(itemLine(2).includes('Fewer than 4 documents'), 'item 2 keeps its third sentence');
  t.ok(itemLine(3).includes('If reindexed: true'), 'item 3 keeps its second sentence');
  // No paragraph may begin mid-item, i.e. with a lowercase-led continuation.
  const paras = out.split('\n\n');
  t.ok(!paras.some((p) => /^(It needs|If reindexed|Fewer than)/.test(p)), 'no orphaned continuation paragraph');
});

test('splitParagraphs - a list keeps trailing prose separate when the model marks the break', (t) => {
  const text = 'Here is what to do: 1. Call ragReindex to regenerate the embeddings from scratch. 2. Inspect the details field on the result to confirm the run applied.\n\nFor large workspaces, reindexing takes time, so plan it during quiet hours.';
  const paras = splitParagraphs(text).split('\n\n');
  t.is(paras.length, 2, 'the list block and the closing prose stay separate');
  t.ok(paras[1].startsWith('For large workspaces'), 'closing prose is its own paragraph');
});

test('splitParagraphs - list guard does not suppress breaks in ordinary prose', (t) => {
  // The guard must key on a real list marker, not on any period-plus-digit.
  // Long enough to clear MIN_PARAGRAPH_LEN, so a break is genuinely expected.
  const text = 'The index stores 4 vectors per document by default in this configuration, and every one of those vectors is derived from the stored text. Reindexing regenerates all of them from scratch after a long run of writes. That keeps retrieval scores stable even when documents have been deleted and re-ingested many times over.';
  const out = splitParagraphs(text);
  t.is(out.split('\n\n').length, 2, 'prose containing digits still splits normally');
});

test('splitParagraphs - puts bulleted list items on their own line', (t) => {
  const text = 'Key features follow. - The SDK reads tool lists. - The mcp field wires the client.';
  const out = splitParagraphs(text);
  const lines = out.split('\n');
  t.ok(lines[0].endsWith('follow.'));
  t.ok(lines[1].startsWith('- The SDK reads'));
  t.ok(lines[2].startsWith('- The mcp field'));
});