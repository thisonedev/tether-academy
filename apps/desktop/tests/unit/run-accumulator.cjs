'use strict';

// Bounded accumulator for the stdout/stderr chunks a peer run emits, used only
// to build the final { ok, output } string (the renderer already saw every
// chunk live via sendChunk). Without a cap, a run that prints in a loop grows main-process memory until the process dies.

const test = require('brittle');

const { createAccumulator, BUDGET_BYTES } = require('../../electron/run-accumulator.cjs');

const ONE_MIB = 1024 * 1024;

test('accumulator - budget is one mebibyte', (t) => {
  t.is(BUDGET_BYTES, ONE_MIB);
});

test('accumulator - under the budget keeps the full stream', (t) => {
  const acc = createAccumulator();
  acc.append('stdout', 'hello ');
  acc.append('stdout', 'world');
  t.is(acc.result('stdout'), 'hello world');
  t.is(acc.dropped('stdout'), 0);
});

test('accumulator - over the budget keeps the head and tail and drops the middle', (t) => {
  const acc = createAccumulator();
  // 2 MiB of stdout: twice the budget.
  const chunk = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 32; i++) acc.append('stdout', chunk);
  const result = acc.result('stdout');
  t.ok(result.length <= ONE_MIB + 128, 'the result fits within budget + marker');
  t.ok(result.includes('…[truncated '), 'a marker line names the dropped bytes');
  t.ok(result.startsWith('x'), 'the head is preserved');
  t.ok(result.endsWith('x'), 'the tail is preserved');
  t.ok(acc.dropped('stdout') > 0, 'and the drop count is positive');
});

test('accumulator - the marker names the exact number of bytes dropped', (t) => {
  const acc = createAccumulator();
  // 2 MiB; 1 MiB worth should be dropped.
  const chunk = 'y'.repeat(8 * 1024);
  for (let i = 0; i < 256; i++) acc.append('stdout', chunk);
  const dropped = acc.dropped('stdout');
  t.ok(dropped >= ONE_MIB - 64 * 1024 && dropped <= ONE_MIB + 64 * 1024,
    'approximately one budget worth was dropped');
  t.ok(result_includes_marker(acc.result('stdout'), dropped), 'the marker matches the count');
});

function result_includes_marker(result, dropped) {
  return result.includes(`…[truncated ${dropped} bytes]`);
}

test('accumulator - the budget is per-stream, not shared', (t) => {
  const acc = createAccumulator();
  const chunk = 's'.repeat(64 * 1024);
  for (let i = 0; i < 32; i++) acc.append('stdout', chunk);
  acc.append('stderr', 'small');
  t.ok(acc.result('stdout').length <= ONE_MIB + 128, 'stdout is bounded');
  t.is(acc.result('stderr'), 'small', 'stderr is untouched');
});

test('accumulator - memory stays flat as more bytes flow in', (t) => {
  const acc = createAccumulator();
  // 10 MiB pushed through. The result must stay within budget + marker.
  const chunk = 'm'.repeat(64 * 1024);
  for (let i = 0; i < 160; i++) acc.append('stdout', chunk);
  t.ok(acc.result('stdout').length <= ONE_MIB + 128, 'memory stays flat');
});