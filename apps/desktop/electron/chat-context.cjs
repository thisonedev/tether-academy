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
    'Answer the user directly and concisely. Use the references below only when the question is actually about the lesson or the SDK; for greetings, small talk, or anything unrelated, reply naturally and briefly instead of explaining the lesson.',
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

function buildVerifySystemPrompt(lessonKey, lessonContext, tests) {
  const base = lessonKey
    ? `You are grading a student's code for a Tether Academy lesson (chapter: ${lessonKey.chapter}, lesson: ${lessonKey.lesson}).`
    : "You are grading a student's code for a Tether Academy lesson.";
  const lesson = trimLessonContext(lessonContext);
  const checklist = tests.map((t) => `- ${t.id}: ${t.description}`).join('\n');
  return [
    base,
    "The code already matched the lesson's required keywords or patterns. Your job is to judge whether it is actually correct and complete, not just superficially present.",
    'For EACH checklist item below, decide exactly one verdict: "pass" (correctly and fully implemented), "partial" (attempted but incomplete, a stub, a TODO, or logically wrong), or "fail" (not implemented at all).',
    'A function or keyword being present with an empty body, a placeholder return, or a comment instead of real logic is "partial", never "pass".',
    'Give one short sentence of reason per item. Do not restate or reveal the full correct solution; describe what is missing or wrong instead.',
    'Respond with ONLY minified JSON matching exactly this shape, nothing else, no markdown fences, no commentary before or after it:',
    '{"items":[{"id":"<test id>","verdict":"pass"|"partial"|"fail","reason":"<one sentence>"}],"summary":"<1-3 sentences on what remains to finish the lesson>"}',
    lesson ? `LESSON REFERENCE:\n${lesson}` : '',
    `CHECKLIST:\n${checklist}`,
  ].filter(Boolean).join('\n');
}

module.exports = {
  MAX_LESSON_CONTEXT_BYTES,
  MAX_DOCS_PROMPT_BYTES,
  trimLessonContext,
  trimDocs,
  buildSystemPrompt,
  buildVerifySystemPrompt,
};
