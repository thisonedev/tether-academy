'use strict';

const test = require('brittle');
const { docsStatus, DOCS_DISK_MAX_BYTES, DOCS_PROMPT_MAX_BYTES, DOCS_URL } = require('../../electron/chat-docs.cjs');

test('chat-docs - exposes the public endpoint and bounded caps', (t) => {
  t.is(DOCS_URL, 'https://docs.qvac.tether.io/llms-full.txt', 'docs URL is correct');
  t.ok(DOCS_DISK_MAX_BYTES >= DOCS_PROMPT_MAX_BYTES, 'disk cap is the outer cap');
  t.ok(DOCS_PROMPT_MAX_BYTES <= 32 * 1024, 'prompt cap is small enough to fit alongside the lesson reference on 1.7B and up');
});

test('chat-docs - status starts empty when no fetch has run', (t) => {
  const status = docsStatus();
  t.is(status.available, false, 'no copy cached yet');
  t.is(status.source, 'none', 'no source reported yet');
  t.is(status.bytes, 0, 'no bytes yet');
  t.ok(typeof status.expiresAt === 'number', 'expiresAt is a number');
});
