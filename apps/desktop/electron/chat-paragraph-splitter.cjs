'use strict';

// Split streamed assistant text into paragraphs by detecting real paragraph
// breaks, not list-item periods or abbreviations. The system prompt asks the
// model to split paragraphs; this post-processes the assembled text so the
// user sees visible breaks when the model has actually changed topic.
//
// Heuristics, in order:
//   1. If the text already contains blank-line separators, honour them.
//   2. Split on `.`/`?`/`!` followed by a capital letter when the next
//      sentence looks like a paragraph opener (not a list marker, not an
//      abbreviation, and at least MIN_NEXT_LEN characters long).
//   3. Once a paragraph reaches MAX_PARAGRAPH_LEN, force a break at the next
//      sentence end regardless.
//   4. Within a paragraph, put each numbered/bulleted list item on its own
//      line (a single newline, not a blank-line break).

const MIN_NEXT_LEN = 20;
const MIN_PARAGRAPH_LEN = 180;
const MAX_PARAGRAPH_LEN = 240;
const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'etc', 'mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr',
  'vs', 'cf', 'no', 'fig', 'approx',
]);

// A bare list-marker numeral like `1.` or `Example: 2.` is not a real
// sentence end on its own. The number introduces the item that follows,
// so it must never trigger a paragraph break by itself.
function endsInBareNumber(sentenceSoFar) {
  return /(?:^|[:\s])\d{1,3}\.$/.test(sentenceSoFar);
}

function isListMarker(s) {
  if (!s) return false;
  if (s[0] === '-' || s[0] === '*' || s[0] === '+') {
    return s[1] === ' ' || s[1] === undefined;
  }
  let i = 0;
  while (i < s.length && s[i] >= '0' && s[i] <= '9') i += 1;
  if (i > 0 && s[i] === '.' && (s[i + 1] === ' ' || s[i + 1] === undefined)) {
    return true;
  }
  return false;
}

function endsInAbbreviation(sentence) {
  const match = sentence.match(/([A-Za-z]+)\.\s*$/);
  if (!match) return false;
  const word = match[1].toLowerCase();
  return ABBREVIATIONS.has(word);
}

// Matches `.`/`:`/`!`/`?` followed by whitespace and then a list marker.
// Operates on a single flattened paragraph (no embedded blank lines), so
// the inserted `\n` can never collide with a paragraph break.
const LIST_ITEM_BREAK_RE = /([.:!?])[ \t]+(?=\d+\.[ \t]|[-*+][ \t])/g;

function breakListItems(paragraph) {
  return paragraph.replace(LIST_ITEM_BREAK_RE, '$1\n');
}

function splitParagraphs(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  const blocks = /\n\s*\n/.test(text)
    ? text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim())
    : [text.replace(/\s+/g, ' ').trim()];
  const paragraphs = blocks.filter((p) => p.length > 0).flatMap(splitSentences);
  return paragraphs.map(breakListItems).join('\n\n');
}

// Splits a single blank-line-delimited block into paragraphs on real
// sentence-boundary topic changes.
function splitSentences(normalised) {
  if (normalised.length === 0) return [];
  const out = [];
  let buffer = '';
  let i = 0;
  while (i < normalised.length) {
    const ch = normalised[i];
    buffer += ch;
    if (ch !== '.' && ch !== '?' && ch !== '!') {
      i += 1;
      continue;
    }
    let peek = i + 1;
    if (normalised[peek] === ' ') peek += 1;
    const next = normalised[peek];
    if (endsInAbbreviation(buffer)) {
      i += 1;
      continue;
    }
    if (endsInBareNumber(buffer)) {
      i += 1;
      continue;
    }
    if (!next) {
      i += 1;
      continue;
    }
    // Force a break past a long paragraph: a long sentence stays whole,
    // but the paragraph doesn't grow past it.
    if (buffer.trim().length >= MAX_PARAGRAPH_LEN) {
      out.push(buffer.trim());
      buffer = '';
      i = peek;
      continue;
    }
    if (!/[A-Z0-9]/.test(next)) {
      i += 1;
      continue;
    }
    const nextSentence = normalised.slice(peek, nextSentenceEnd(normalised, peek));
    if (isListMarker(nextSentence)) {
      i += 1;
      continue;
    }
    if (nextSentence.length < MIN_NEXT_LEN) {
      i += 1;
      continue;
    }
    if (buffer.trim().length < MIN_PARAGRAPH_LEN) {
      i += 1;
      continue;
    }
    out.push(buffer.trim());
    buffer = '';
    i = peek;
  }
  if (buffer.trim().length > 0) out.push(buffer.trim());
  return out;
}

function nextSentenceEnd(text, from) {
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '.' || ch === '?' || ch === '!') return i;
  }
  return text.length;
}

module.exports = { splitParagraphs };