'use strict';

// The playground's only credential store: a workflow JSON may reference a
// name, never a value, and the value on disk is always secret-storage-sealed.

const test = require('brittle');
const fs = require('node:fs');
const path = require('node:path');
const { createPlaygroundCredentials } = require('../../electron/playground-credentials.cjs');
const { createSecretStorage } = require('../../electron/secret-storage.cjs');
const { tmpDir } = require('../helpers/index.cjs');

function store(t, name) {
  const dir = tmpDir(t, name);
  const secretStorage = createSecretStorage(dir, { safeStorage: null, keyDir: dir });
  return { dir, creds: createPlaygroundCredentials(dir, { secretStorage }) };
}

test('playground-credentials - round-trips a value and lists only its name', (t) => {
  const { creds } = store(t, 'creds-roundtrip');
  creds.set('openai-key', 'sk-test-123');

  t.alike(creds.list(), ['openai-key']);
  t.is(creds.get('openai-key'), 'sk-test-123');
});

test('playground-credentials - the on-disk file never holds the plaintext', (t) => {
  const { dir, creds } = store(t, 'creds-plaintext');
  creds.set('api-key', 'super-secret-value');

  const raw = fs.readFileSync(path.join(dir, 'playground-credentials.json'), 'utf8');
  t.absent(raw.includes('super-secret-value'), 'plaintext never lands in the store file');
});

test('playground-credentials - delete removes it, get on a missing name is null', (t) => {
  const { creds } = store(t, 'creds-delete');
  creds.set('temp', 'value');

  t.is(creds.delete('temp'), true);
  t.is(creds.delete('temp'), false, 'already gone the second time');
  t.is(creds.get('temp'), null);
  t.alike(creds.list(), []);
});
