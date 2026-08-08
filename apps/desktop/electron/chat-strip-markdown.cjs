'use strict';

// Sanitize streamed deltas so the user never sees Markdown emphasis, inline
// code, or heading hashes even if the model slips. The system prompt asks
// for plain text; this is the safety net.
//
// Tokens arrive one at a time, so we do a per-chunk sanitize pass plus a
// carry buffer for an opener that may straddle a chunk boundary. If an
// emphasis opener is still unmatched at flush time, we emit the held text
// as visible text so the user sees something for the partial emphasis.
//
// When scanning for a closer we walk past any *other* emphasis delimiters
// we encounter, so `**foo*bar**` correctly identifies the second `**` as
// the closer rather than the inner `*`.

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
      if ((ch === '-' || ch === '+') && (i === 0 || input[i - 1] === '\n') && input[i + 1] === ' ') {
        i += 2;
        continue;
      }
      const digitStart = (i === 0 || input[i - 1] === '\n') && ch >= '0' && ch <= '9';
      if (digitStart) {
        let j = i + 1;
        while (j < input.length && input[j] >= '0' && input[j] <= '9') j += 1;
        if (j < input.length && input[j] === '.' && input[j + 1] === ' ') {
          i = j + 2;
          continue;
        }
      }
      if (ch === '>' && (i === 0 || input[i - 1] === '\n') && input[i + 1] === ' ') {
        i += 2;
        continue;
      }
      out += ch;
      i += 1;
    }
    return out;
  }

  function flush() {
    if (carry.length === 0) return '';
    const out = carry;
    carry = '';
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

  return { push, flush };
}

module.exports = { createMarkdownStripper };