'use strict';

const test = require('brittle');
const { createThinkingFilter } = require('../../electron/chat-thinking-filter.cjs');

test('chat thinking filter removes a complete think block', (t) => {
  const filter = createThinkingFilter();
  t.is(filter.push('<think>private reasoning</think>Hi!'), 'Hi!');
  t.is(filter.flush(), '');
});

test('chat thinking filter removes tags split across streamed chunks', (t) => {
  const filter = createThinkingFilter();
  t.is(filter.push('<thi'), '');
  t.is(filter.push('nk>private'), '');
  t.is(filter.push(' reasoning</thi'), '');
  t.is(filter.push('nk>Hi'), 'Hi');
  t.is(filter.push(' there'), ' there');
  t.is(filter.flush(), '');
});

test('chat thinking filter preserves ordinary answer text', (t) => {
  const filter = createThinkingFilter();
  t.is(filter.push('A normal answer with < symbols.'), 'A normal answer with < symbols.');
  t.is(filter.flush(), '');
});

test('chat thinking filter discards an unterminated think block', (t) => {
  const filter = createThinkingFilter();
  t.is(filter.push('<think>private reasoning'), '');
  t.is(filter.flush(), '');
});
