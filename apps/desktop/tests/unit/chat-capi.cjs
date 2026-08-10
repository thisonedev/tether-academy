'use strict';

const test = require('brittle');

// The send() path matches this against the user's latest message. Keep the
// definition here in lockstep with the inline check in chat.cjs; if one moves,
// update the other.
const KEYWORD_PATTERN = /(\b[A-Z][A-Z0-9_]{2,}|@[\w./-]+|\bclass\b|\bfunction\b|\bapi\b|\bmethod\b|\bmodule\b|\btype\b|\binterface\b)/;
const TERM_LOOKUP_PATTERN = /\b(?:what'?s|what is|define|explain)\s+(?:an?\s+|the\s+)?[\w().'-]{1,24}\s*\??\s*$/i;
const wantsApiDetails = (text) => KEYWORD_PATTERN.test(text) || TERM_LOOKUP_PATTERN.test(text.trim());

test('chat-capi - matches class/function/api keywords', (t) => {
  t.ok(wantsApiDetails('how does the completion class work?'));
  t.ok(wantsApiDetails('show me the api'));
  t.ok(wantsApiDetails('what type should I use?'));
});

test('chat-capi - matches SCREAMING_CASE constants and @scoped packages', (t) => {
  t.ok(wantsApiDetails('what does LOAD_MODEL do?'));
  t.ok(wantsApiDetails('how do I use @qvac/sdk?'));
  t.ok(wantsApiDetails('import @modelcontextprotocol/sdk/client'));
});

test('chat-capi - matches lowercase term lookups', (t) => {
  t.ok(wantsApiDetails("what's mcp?"), 'lowercase acronym in a "what\'s X" question');
  t.ok(wantsApiDetails('what is rag'), 'lowercase acronym in a "what is X" question');
  t.ok(wantsApiDetails('define completion()'), 'define + short term');
});

test('chat-capi - skips greetings and short questions', (t) => {
  t.absent(wantsApiDetails('hi'), 'plain greeting');
  t.absent(wantsApiDetails('how are you?'), 'small words only');
  t.absent(wantsApiDetails('explain the key idea in one paragraph.'), 'explain + full sentence, not a term lookup');
});
