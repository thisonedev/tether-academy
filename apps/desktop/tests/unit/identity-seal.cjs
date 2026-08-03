'use strict';

// Secret storage: the AES-256-GCM fallback used when no OS keychain is
// available. The Corestore identity core this file also used to cover is gone;
// the device identity it duplicated lives in identity/manager.cjs and is
// covered by identity-manager.cjs.

const test = require('brittle');
const fs = require('node:fs');
const path = require('node:path');

const { createSecretStorage, localKeyPath, LOCAL_KEY_FILE } = require('../../electron/secret-storage.cjs');
const { tmpDir } = require('../helpers/index.cjs');

// A key file an older build left beside the sealed record has to move, not be
// regenerated: every record sealed with it becomes unreadable otherwise.
test('identity-seal - a key left in userData by an older build is moved, not replaced', (t) => {
  const dir = tmpDir(t, 'id-seal-migrate-key');
  const keyDir = tmpDir(t, 'id-seal-migrate-key-dest');
  const legacy = path.join(dir, LOCAL_KEY_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(legacy, Buffer.alloc(32, 7), { mode: 0o600 });

  const sealed = createSecretStorage(dir, { safeStorage: null, keyDir }).encryptString('x');

  t.absent(fs.existsSync(legacy), 'the old copy is gone');
  t.alike(fs.readFileSync(localKeyPath(dir, keyDir)), Buffer.alloc(32, 7), 'same key, new home');
  t.is(createSecretStorage(dir, { safeStorage: null, keyDir }).decryptString(sealed), 'x');
});

test('identity-seal - secret storage round-trips without the OS keychain', (t) => {
  const secrets = createSecretStorage(tmpDir(t, 'id-seal-secrets'), {
    safeStorage: null,
    keyDir: tmpDir(t, 'id-seal-secrets-keys'),
  });

  const sealed = secrets.encryptString('super-secret-material');
  t.not(sealed, 'super-secret-material', 'ciphertext differs from plaintext');
  t.is(secrets.decryptString(sealed), 'super-secret-material');
});
