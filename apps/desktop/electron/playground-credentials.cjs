'use strict';

// Per-node credentials for the playground: a workflow JSON is meant to
// reference these by name only, never inline. Every value on disk is sealed
// through secret-storage.cjs (OS keychain via Electron safeStorage, AES-256-GCM local fallback).

const fs = require('node:fs');
const path = require('node:path');
const { createSecretStorage } = require('./secret-storage.cjs');

const FILE_NAME = 'playground-credentials.json';

function filePath(userDataDir) {
  return path.join(userDataDir, FILE_NAME);
}

function readStore(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(userDataDir), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(userDataDir, store) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(filePath(userDataDir), JSON.stringify(store, null, 2), { mode: 0o600 });
}

/**
 * @param {string} userDataDir
 * @param {{ secretStorage?: object }} [opts] secretStorage: injected for tests.
 */
function createPlaygroundCredentials(userDataDir, opts = {}) {
  const secrets = opts.secretStorage || createSecretStorage(userDataDir, opts);

  return {
    /** Names only, never values: safe to hand to the renderer for a picker UI. */
    list() {
      return Object.keys(readStore(userDataDir)).sort();
    },
    set(name, value) {
      const store = readStore(userDataDir);
      store[name] = secrets.encryptString(value);
      writeStore(userDataDir, store);
    },
    /** Plaintext. Main-process callers only; never exposed to the renderer. */
    get(name) {
      const store = readStore(userDataDir);
      return Object.hasOwn(store, name) ? secrets.decryptString(store[name]) : null;
    },
    delete(name) {
      const store = readStore(userDataDir);
      if (!Object.hasOwn(store, name)) return false;
      delete store[name];
      writeStore(userDataDir, store);
      return true;
    },
  };
}

module.exports = { createPlaygroundCredentials };
