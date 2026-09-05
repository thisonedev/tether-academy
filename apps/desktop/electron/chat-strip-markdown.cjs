'use strict';

// Sanitize streamed deltas: Markdown and em/en dashes get through the model
// sometimes despite the system prompt, so this is a safety net, not a
// substitute for it. Chunked, so open delimiters carry across push() calls.

function createMarkdownStripper() {
  let carry = '';

  function push(text) {
    if (typeof text !== 'string' || text.length === 0) {
      if (carry.length === 0) return '';
      const out = carry;
      carry = '';
      return out;
    }
    const input = carry + text;
    carry = '';
    let out = '';
    let i = 0;
    while (i < input.length) {
      const ch = input[i];
      if (input.startsWith('```', i)) {
        const end = input.indexOf('```', i + 3);
        if (end < 0) {
          i += 3;
          continue;
        }
        let bodyStart = i + 3;
        const langEnd = input.indexOf('\n', bodyStart);
        if (langEnd >= 0 && langEnd < end) {
          bodyStart = langEnd + 1;
        } else {
          bodyStart = end;
        }
        let bodyEnd = end;
        while (bodyEnd > bodyStart && input[bodyEnd - 1] === '\n') bodyEnd -= 1;
        out += input.slice(bodyStart, bodyEnd);
        i = end + 3;
        if (input[i] === '\n') i += 1;
        continue;
      }
      if (input.startsWith('**', i)) {
        const closeAt = findCloseAt(input, i + 2, '**');
        if (closeAt >= 0) {
          out += input.slice(i + 2, closeAt);
          i = closeAt + 2;
          continue;
        }
        carry = input.slice(i);
        break;
      }
      if (ch === '*') {
        const closeAt = findItalicCloseAt(input, i + 1);
        if (closeAt >= 0) {
          out += input.slice(i + 1, closeAt);
          i = closeAt + 1;
          continue;
        }
        carry = input.slice(i);
        break;
      }
      if (ch === '`') {
        const closeAt = input.indexOf('`', i + 1);
        if (closeAt > i + 1 && !input.slice(i + 1, closeAt).includes('\n')) {
          out += input.slice(i + 1, closeAt);
          i = closeAt + 1;
          continue;
        }
        carry = input.slice(i);
        break;
      }
      if (ch === '#' && (i === 0 || input[i - 1] === '\n')) {
        let j = i;
        while (j < input.length && input[j] === '#') j += 1;
        if (j < input.length && input[j] === ' ') {
          i = j + 1;
          continue;
        }
      }
      // Bullet ("- ") and numbered ("1. ") markers survive, unlike everything else here:
      // stripping them turned a requested list into one run-on paragraph.
      if (ch === '>' && (i === 0 || input[i - 1] === '\n') && input[i + 1] === ' ') {
        i += 2;
        continue;
      }
      if (ch === '—' || ch === '–') {
        const resolved = resolveDash(input, i);
        if (!resolved) {
          // Carry the preceding space with the dash so it can still be trimmed later.
          if (out.endsWith(' ')) {
            out = out.slice(0, -1);
            carry = ' ' + input.slice(i);
          } else {
            carry = input.slice(i);
          }
          break;
        }
        if (resolved.trimPrecedingSpace && out.endsWith(' ')) out = out.slice(0, -1);
        out += resolved.replacement;
        i += resolved.consumed;
        continue;
      }
      out += ch;
      i += 1;
    }
    // Hold a trailing space back in case the next chunk starts with a dash.
    if (carry === '') {
      const trailingSpace = /[ \t]+$/.exec(out);
      if (trailingSpace) {
        carry = trailingSpace[0];
        out = out.slice(0, -trailingSpace[0].length);
      }
    }
    return out;
  }

  function flush() {
    if (carry.length === 0) return '';
    const input = carry;
    carry = '';
    let out = '';
    let i = 0;
    while (i < input.length) {
      const ch = input[i];
      // Force a decision here; nothing more is coming to wait on.
      if (ch === '—' || ch === '–') {
        const resolved = resolveDash(input, i, true);
        if (resolved) {
          if (resolved.trimPrecedingSpace && out.endsWith(' ')) out = out.slice(0, -1);
          out += resolved.replacement;
          i += resolved.consumed;
          continue;
        }
      }
      out += ch;
      i += 1;
    }
    return out;
  }

  function findCloseAt(haystack, from, delim) {
    for (let i = from; i < haystack.length; i += 1) {
      if (haystack[i] === '\\') {
        i += 1;
        continue;
      }
      if (haystack.startsWith(delim, i)) {
        return i;
      }
    }
    return -1;
  }

  function findItalicCloseAt(haystack, from) {
    for (let i = from; i < haystack.length; i += 1) {
      if (haystack[i] === '\\') {
        i += 1;
        continue;
      }
      if (haystack[i] !== '*') continue;
      if (haystack[i + 1] === '*') {
        i += 1;
        continue;
      }
      if (haystack[i - 1] === '*') continue;
      return i;
    }
    return -1;
  }

  // Tight ("10-20") -> hyphen. Paired ("word - aside - word") -> aside
  // dropped. Single -> split into a new, capitalized sentence. Returns
  // null (carry to next chunk) unless final=true.
  function resolveDash(input, i, final = false) {
    const prevChar = i > 0 ? input[i - 1] : ' ';
    const nextChar = input[i + 1];
    if (nextChar === undefined) {
      if (!final) return null;
      return { consumed: 1, replacement: '', trimPrecedingSpace: true };
    }
    const tightBefore = prevChar !== ' ' && prevChar !== '\n';
    const tightAfter = nextChar !== ' ' && nextChar !== '\n';
    if (tightBefore && tightAfter) {
      return { consumed: 1, replacement: '-', trimPrecedingSpace: false };
    }
    let j = i + 1;
    while (j < input.length) {
      const c = input[j];
      if (c === '—' || c === '–') {
        return { consumed: j - i + 1, replacement: '', trimPrecedingSpace: true };
      }
      if (c === '.' || c === '!' || c === '?' || c === '\n') {
        return { consumed: j - i + 1, replacement: newSentence(input.slice(i + 1, j + 1)), trimPrecedingSpace: true };
      }
      j += 1;
    }
    if (!final) return null;
    return { consumed: 1 + (input.length - (i + 1)), replacement: newSentence(input.slice(i + 1)), trimPrecedingSpace: true };
  }

  // Forces one space and a capital letter; the source's own spacing/casing here isn't reliable.
  function newSentence(text) {
    const trimmed = text.replace(/^\s+/, '');
    const capitalized = trimmed.length > 0 ? trimmed[0].toUpperCase() + trimmed.slice(1) : trimmed;
    return `. ${capitalized}`;
  }

  return { push, flush };
}

module.exports = { createMarkdownStripper };