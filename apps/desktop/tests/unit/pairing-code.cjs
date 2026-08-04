'use strict';

const test = require('brittle');

const pairingCode = require('../../workers/peer/pairing-code.cjs');

test('pairing-code - generate produces a code of the declared length', (t) => {
  const code = pairingCode.generate();
  t.is(code.length, pairingCode.PAIRING_CODE_LEN);
  t.ok(/^[A-Z2-9]+$/.test(code), 'uppercase, no ambiguous 0/1/I/O');
});

test('pairing-code - normalize strips separators and upcases', (t) => {
  t.is(pairingCode.normalize('ab cd-ef'), 'ABCDEF');
  t.is(pairingCode.normalize('234567'), '234567');
});

test('pairing-code - equal ignores case and separators', (t) => {
  const code = pairingCode.generate();
  t.is(pairingCode.equal(code, code), true);
  t.is(pairingCode.equal(code.toLowerCase(), code), true);
  t.is(pairingCode.equal(code.split('').join('-'), code), true);
});

test('pairing-code - equal rejects mismatches and non-strings', (t) => {
  const code = pairingCode.generate();
  t.is(pairingCode.equal(code, 'AAAAAA'), false);
  t.is(pairingCode.equal('short', code), false);
  t.is(pairingCode.equal(code, null), false);
  t.is(pairingCode.equal(undefined, code), false);
  t.is(pairingCode.equal(1, code), false);
});

// Same-length inputs are the case that reaches timingSafeEqual; a length
// mismatch short-circuits before it.
test('pairing-code - equal compares same-length codes correctly', (t) => {
  t.is(pairingCode.equal('AAAAAA', 'BBBBBB'), false);
  t.is(pairingCode.equal('AAAAAA', 'AAAAAA'), true);
});
