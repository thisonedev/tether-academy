'use strict';

const test = require('brittle');

const {
  createPairingAttemptGate,
  DEFAULT_MAX_ATTEMPTS,
} = require('../../workers/peer/pairing-attempt-gate.cjs');

// The gate takes an explicit timestamp, so these stay pure and never sleep.

test('attempt-gate - counts a failure outside the backoff window', (t) => {
  const gate = createPairingAttemptGate({ maxAttempts: 3, backoffMs: 1000 });
  const now = 1_000_000;

  t.is(gate.recordFailure(now), 'mismatch');
  t.is(gate.attempts, 1);
  t.is(gate.invalidated, false);
});

test('attempt-gate - rapid retries inside the backoff window are not counted', (t) => {
  const gate = createPairingAttemptGate({ maxAttempts: 3, backoffMs: 1000 });
  const now = 1_000_000;

  gate.recordFailure(now);
  t.is(gate.recordFailure(now + 100), 'backoff', 'too soon to count');
  t.is(gate.attempts, 1, 'attempt count unchanged');

  t.is(gate.recordFailure(now + 1001), 'mismatch', 'past the window, counts again');
  t.is(gate.attempts, 2);
});

test('attempt-gate - invalidates the invite once max attempts is reached', (t) => {
  const gate = createPairingAttemptGate({ maxAttempts: 3, backoffMs: 1000 });
  let now = 1_000_000;

  gate.recordFailure(now);
  gate.recordFailure((now += 1001));
  t.is(gate.recordFailure((now += 2000)), 'lockout');
  t.is(gate.attempts, 3);
  t.is(gate.invalidated, true);

  t.is(gate.recordFailure(now + 10_000), 'lockout', 'stays locked out');
  t.is(gate.attempts, 3, 'no further counting after lockout');
});

test('attempt-gate - defaults lock out after DEFAULT_MAX_ATTEMPTS', (t) => {
  const gate = createPairingAttemptGate();
  t.is(gate.maxAttempts, DEFAULT_MAX_ATTEMPTS);

  for (let i = 0; i < DEFAULT_MAX_ATTEMPTS - 1; i++) {
    t.is(gate.recordFailure(i * 10_000), 'mismatch');
  }
  t.is(gate.recordFailure(DEFAULT_MAX_ATTEMPTS * 10_000), 'lockout');
});
