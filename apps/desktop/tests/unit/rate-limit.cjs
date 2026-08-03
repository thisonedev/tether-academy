'use strict';

// Per-discovery-key sliding-window limiter for the peer paths. The window
// is a list of timestamps, pruned on read so nothing accumulates for a peer
// that went away. The interface is intentionally narrow: the caller passes
// the op name and a key (discovery-key hex for per-peer ops, a constant
// sentinel for global ones), and gets back whether to proceed. The clock
// is injectable so the tests do not have to sleep a minute.

const test = require('brittle');

const { isAllowed, reset, _resetAllForTests, LIMITS } = require('../../workers/peer/rate-limit.cjs');

test('rate-limit - under the cap is allowed', (t) => {
  _resetAllForTests();
  let now = 1_000_000;
  for (let i = 0; i < 5; i++) {
    t.is(isAllowed('identity:frame', 'peer-a', now), true, `attempt ${i + 1} under the limit`);
    now += 1;
  }
});

test('rate-limit - the cap is enforced', (t) => {
  _resetAllForTests();
  const op = 'exec:request';
  const key = 'peer-b';
  let now = 1_000_000;
  for (let i = 0; i < 10; i++) {
    t.is(isAllowed(op, key, now), true, `attempt ${i + 1} within budget`);
    now += 1;
  }
  t.is(isAllowed(op, key, now), false, 'the 11th is refused');
});

test('rate-limit - past the window the count rolls', (t) => {
  _resetAllForTests();
  const op = 'exec:request';
  const key = 'peer-c';
  let now = 1_000_000;
  for (let i = 0; i < 10; i++) {
    isAllowed(op, key, now);
    now += 1;
  }
  t.is(isAllowed(op, key, now), false, 'over budget now');
  // Advance past the 60_000 ms window.
  now += 60_001;
  t.is(isAllowed(op, key, now), true, 'after a full window the budget refills');
});

test('rate-limit - per-key isolation: one peer flooding does not starve another', (t) => {
  _resetAllForTests();
  const op = 'exec:request';
  const now = 1_000_000;
  for (let i = 0; i < 10; i++) isAllowed(op, 'peer-d', now);
  t.is(isAllowed(op, 'peer-d', now), false, 'peer-d is at its cap');
  t.is(isAllowed(op, 'peer-e', now), true, 'peer-e has its own budget');
});

test('rate-limit - global pairing bound shares one budget across invites', (t) => {
  _resetAllForTests();
  const op = 'pairing:attempt';
  let now = 1_000_000;
  // 20 per minute global; 20 attempts on a sentinel key exhaust the budget.
  for (let i = 0; i < 20; i++) isAllowed(op, '__pairing__', now);
  t.is(isAllowed(op, '__pairing__', now), false, 'the budget is shared globally');
});

test('rate-limit - reset(key) clears the window for that key only', (t) => {
  _resetAllForTests();
  const op = 'identity:frame';
  const now = 1_000_000;
  for (let i = 0; i < 60; i++) isAllowed(op, 'peer-f', now);
  t.is(isAllowed(op, 'peer-f', now), false, 'at cap');
  reset('peer-f');
  t.is(isAllowed(op, 'peer-f', now), true, 'reset clears the budget');
  for (let i = 0; i < 60; i++) isAllowed(op, 'peer-g', now);
  t.is(isAllowed(op, 'peer-g', now), false, 'peer-g untouched');
});

test('rate-limit - limit-only-the-listed-ops: unknown op is refused by name', (t) => {
  _resetAllForTests();
  t.is(isAllowed('peer:unknown-op', 'peer-h', Date.now()), false, 'unknown op returns false');
});

test('rate-limit - pruning: a peer that left and came back starts fresh', (t) => {
  _resetAllForTests();
  const op = 'identity:frame';
  const key = 'peer-i';
  let now = 1_000_000;
  for (let i = 0; i < 60; i++) isAllowed(op, key, now);
  t.is(isAllowed(op, key, now), false, 'at cap');
  now += 60_001;
  t.is(isAllowed(op, key, now), true, 'pruned and admitted');
});

// Pin the table itself so a future edit to the limits is a deliberate change,
// not a silent one. The plan documents each row and its reason.
test('rate-limit - limits table matches the documented rows', (t) => {
  t.alike(LIMITS['exec:request'],    { max: 10,  windowMs: 60_000 });
  t.alike(LIMITS['pairing:attempt'], { max: 20,  windowMs: 60_000 });
  t.alike(LIMITS['identity:frame'],  { max: 60,  windowMs: 60_000 });
  t.alike(LIMITS['rpc:command'],     { max: 600, windowMs: 60_000 });
});