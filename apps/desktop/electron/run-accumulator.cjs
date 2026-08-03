// Bounded accumulator for the stdout/stderr chunks a peer run emits. The
// renderer has already seen every chunk live through sendChunk; this buffer
// exists only to build the final { ok, output } string. Without a cap, a run
// that prints in a loop grows main-process memory until the process dies —
// the defect this caps.
//
// 1 MiB per stream; on overflow, keep the first HEAD_BYTES and the last
// TAIL_BYTES and drop the middle, inserting one marker line naming how many
// bytes were dropped.
'use strict';

const BUDGET_BYTES = 1024 * 1024;
const HEAD_BYTES = BUDGET_BYTES / 2;
const TAIL_BYTES = BUDGET_BYTES - HEAD_BYTES;
const MARKER = (n) => `…[truncated ${n} bytes]`;

function createAccumulator({ budgetBytes = BUDGET_BYTES } = {}) {
  const headBudget = Math.floor(budgetBytes / 2);
  const tailBudget = budgetBytes - headBudget;
  // stream -> { head, tail, dropped }
  const streams = new Map();

  function ensure(stream) {
    let entry = streams.get(stream);
    if (!entry) {
      entry = { head: '', tail: '', dropped: 0 };
      streams.set(stream, entry);
    }
    return entry;
  }

  function append(stream, chunk) {
    if (typeof chunk !== 'string' || chunk.length === 0) return;
    const entry = ensure(stream);
    entry.tail += chunk;
    // The tail itself cannot grow past the tail budget.
    if (entry.tail.length > tailBudget) {
      const overflow = entry.tail.length - tailBudget;
      // Before head fills, fill it with the front of the stream we are
      // about to slide off the tail; after head fills, count as dropped.
      if (entry.head.length < headBudget) {
        const take = Math.min(headBudget - entry.head.length, overflow);
        entry.head += entry.tail.slice(0, take);
        entry.tail = entry.tail.slice(take);
      } else {
        entry.dropped += overflow;
        entry.tail = entry.tail.slice(overflow);
      }
    }
  }

  function result(stream) {
    const entry = streams.get(stream);
    if (!entry) return '';
    if (entry.dropped === 0) return entry.tail;
    return `${entry.head}${MARKER(entry.dropped)}\n${entry.tail}`;
  }

  function dropped(stream) {
    const entry = streams.get(stream);
    return entry ? entry.dropped : 0;
  }

  return { append, result, dropped };
}

module.exports = {
  createAccumulator,
  BUDGET_BYTES,
};