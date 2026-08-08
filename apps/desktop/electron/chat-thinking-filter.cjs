'use strict';

const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

function createThinkingFilter() {
  let buffer = '';
  let thinking = false;

  function push(text) {
    if (typeof text !== 'string' || text.length === 0) return '';
    buffer += text;
    let visible = '';

    while (buffer.length > 0) {
      if (thinking) {
        const closeAt = buffer.indexOf(CLOSE_TAG);
        if (closeAt >= 0) {
          buffer = buffer.slice(closeAt + CLOSE_TAG.length);
          thinking = false;
          continue;
        }
        const keep = longestTagPrefixSuffix(buffer, CLOSE_TAG);
        buffer = keep > 0 ? buffer.slice(-keep) : '';
        break;
      }

      const openAt = buffer.indexOf(OPEN_TAG);
      if (openAt >= 0) {
        visible += buffer.slice(0, openAt);
        buffer = buffer.slice(openAt + OPEN_TAG.length);
        thinking = true;
        continue;
      }

      const keep = longestTagPrefixSuffix(buffer, OPEN_TAG);
      const end = buffer.length - keep;
      visible += buffer.slice(0, end);
      buffer = buffer.slice(end);
      break;
    }

    return visible;
  }

  function flush() {
    if (thinking) {
      buffer = '';
      return '';
    }
    const visible = buffer;
    buffer = '';
    return visible;
  }

  return { push, flush };
}

function longestTagPrefixSuffix(text, tag) {
  const max = Math.min(text.length, tag.length - 1);
  for (let size = max; size > 0; size -= 1) {
    if (text.endsWith(tag.slice(0, size))) return size;
  }
  return 0;
}

module.exports = { createThinkingFilter };
