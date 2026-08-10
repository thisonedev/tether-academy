'use strict';

// parseVerifyResponse turns the AI reviewer's raw text into a verdict; the
// recovery path (cut-off JSON) matters as much as the happy path here.

const test = require('brittle');
const { parseVerifyResponse } = require('../../electron/chat.cjs');

test('chat-verify-parse - well-formed JSON parses directly', (t) => {
  const text = '{"verdict":"complete","reason":"just written differently"}';
  t.alike(parseVerifyResponse(text), { verdict: 'complete', reason: 'just written differently' });
});

test('chat-verify-parse - prose wrapping the JSON is ignored', (t) => {
  const text = 'Sure, here is my review:\n{"verdict":"wrong","reason":"does not call the API"}\nLet me know if you need more.';
  t.alike(parseVerifyResponse(text), { verdict: 'wrong', reason: 'does not call the API' });
});

test('chat-verify-parse - recovers the verdict when the reason string was cut off mid-JSON', (t) => {
  // Simulates predict budget running out mid-string, a real failure mode.
  const text = '{"verdict":"unfinished","reason":"still missing the loop that reads';
  const result = parseVerifyResponse(text);
  t.ok(result, 'a result is still returned rather than null');
  t.is(result.verdict, 'unfinished');
  t.is(result.reason, 'still missing the loop that reads', 'the trailing incomplete reason is kept as-is');
});

test('chat-verify-parse - garbled non-JSON text with no verdict field returns null', (t) => {
  t.is(parseVerifyResponse('the model just said something'), null);
  t.is(parseVerifyResponse(''), null);
});

test('chat-verify-parse - an unrecognized verdict value returns null', (t) => {
  t.is(parseVerifyResponse('{"verdict":"pass","reason":"ok"}'), null, 'the old per-item verdict set is no longer valid');
});

test('chat-verify-parse - missing reason defaults to an empty string', (t) => {
  t.alike(parseVerifyResponse('{"verdict":"complete"}'), { verdict: 'complete', reason: '' });
});
