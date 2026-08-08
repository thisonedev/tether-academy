// The 0.6B Qwen preset has a 1024-token window. Larger presets can fit the
// lesson reference plus a slice of the SDK docs; this cap keeps both small
// enough for the smallest preset.
const MAX_LESSON_CONTEXT_BYTES = 24_000;
const MAX_DOCS_PROMPT_BYTES = 12_000;

function trimLessonContext(context) {
  if (!context || typeof context !== 'object') return null;
  const fields = [
    ['title', context.title],
    ['description', context.description],
    ['content', context.content],
    ['startingCode', context.startingCode],
    ['answer', context.answer],
    ['hints', Array.isArray(context.hints) ? context.hints.join('\n- ') : ''],
    ['expectedOutput', Array.isArray(context.expectedOutput) ? context.expectedOutput.join('\n- ') : ''],
  ];
  let out = '';
  for (const [label, value] of fields) {
    if (typeof value !== 'string' || value.length === 0) continue;
    const remaining = MAX_LESSON_CONTEXT_BYTES - out.length;
    if (remaining <= 0) break;
    out += `${label}: ${value.slice(0, remaining)}\n`;
  }
  return out.trim() || null;
}

function trimDocs(docs) {
  if (typeof docs !== 'string' || docs.length === 0) return null;
  return docs.slice(0, MAX_DOCS_PROMPT_BYTES);
}

function buildSystemPrompt(lessonKey, lessonContext, docs) {
  const base = lessonKey
    ? `You are a helpful assistant inside a Tether Academy lesson (chapter: ${lessonKey.chapter}, lesson: ${lessonKey.lesson}).`
    : 'You are a helpful assistant inside Tether Academy, an interactive code school.';
  // Trim even at the cap so a smaller preset can't overflow from the
  // reference alone.
  const lesson = trimLessonContext(lessonContext);
  const reference = trimDocs(docs);
  return [
    base,
    'Answer the user directly and concisely. Use the references below when present; otherwise answer from general knowledge.',
    'Do not invent names, tools, packages, protocols, APIs, or facts.',
    'If unsure, say so rather than guessing.',
    'Ignore typos and answer the intended question. Do not mention or correct spelling unless asked.',
    'Return only the answer. Never include private reasoning, analysis, or think blocks.',
    'Format: plain text only. No Markdown, no asterisks, no backticks, no headings, no bullet points, no numbered lists, no code blocks. Use real words and complete sentences.',
    'Structure the answer as short paragraphs. Separate paragraphs with a single blank line. One idea per paragraph. Do not write one long run-on paragraph.',
    lesson ? `LESSON REFERENCE:\n${lesson}` : '',
    reference ? `SDK DOCUMENTATION REFERENCE:\n${reference}` : '',
  ].filter(Boolean).join('\n');
}

module.exports = {
  MAX_LESSON_CONTEXT_BYTES,
  MAX_DOCS_PROMPT_BYTES,
  trimLessonContext,
  trimDocs,
  buildSystemPrompt,
};
