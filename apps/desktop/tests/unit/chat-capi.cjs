'use strict';

const test = require('brittle');

// The send() path matches this against the user's latest message. Keep the
// definition here in lockstep with the inline check in chat.cjs; if one moves,
// update the other.
const WANTS_API_DETAILS = /(\b[A-Z][A-Z0-9_]{2,}|@[\w./-]+|\bclass\b|\bfunction\b|\bapi\b|\bmethod\b|\bmodule\b|\btype\b|\binterface\b)/;

test('chat-capi - matches class/function/api keywords', (t) => {
  t.ok(WANTS_API_DETAILS.test('how does the completion class work?'));
  t.ok(WANTS_API_DETAILS.test('show me the api'));
  t.ok(WANTS_API_DETAILS.test('what type should I use?'));
});

test('chat-capi - matches SCREAMING_CASE constants and @scoped packages', (t) => {
  t.ok(WANTS_API_DETAILS.test('what does LOAD_MODEL do?'));
  t.ok(WANTS_API_DETAILS.test('how do I use @qvac/sdk?'));
  t.ok(WANTS_API_DETAILS.test('import @modelcontextprotocol/sdk/client'));
});

test('chat-capi - skips greetings and short questions', (t) => {
  t.absent(WANTS_API_DETAILS.test('hi'), 'plain greeting');
  t.absent(WANTS_API_DETAILS.test('how are you?'), 'small words only');
  t.absent(WANTS_API_DETAILS.test('explain the key idea in one paragraph.'), 'no class-like token');
});
