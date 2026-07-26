const path = require('node:path');
const fs = require('node:fs');
const { generateKeyPairSync } = require('node:crypto');
const Corestore = require('corestore');

function jwkHex(keyObject, field) {
  const jwk = keyObject.export({ format: 'jwk' });
  return Buffer.from(jwk[field], 'base64url').toString('hex');
}

async function createStore(userDataDir) {
  const dir = path.join(userDataDir, 'corestore');
  fs.mkdirSync(dir, { recursive: true });
  const store = new Corestore(dir);

  const identity = await loadIdentity(store);
  const cache = await loadOrMigrateState(store, userDataDir);

  const stateCore = store.get({ name: 'kv-state', valueEncoding: 'json' });
  await stateCore.ready();

  return {
    identity,

    async get(key) {
      return Object.hasOwn(cache, key) ? cache[key] : null;
    },

    async set(key, value) {
      cache[key] = value;
      await stateCore.append({ op: 'set', key, value, ts: Date.now() });
    },

    async remove(key) {
      if (!Object.hasOwn(cache, key)) return;
      delete cache[key];
      await stateCore.append({ op: 'remove', key, ts: Date.now() });
    },

    async list() {
      return Object.entries(cache).map(([key, value]) => ({ key, value }));
    },

    async close() {
      await store.close();
    },
  };
}

async function loadIdentity(store) {
  const core = store.get({ name: 'identity', valueEncoding: 'binary' });
  await core.ready();

  if (core.length > 0) {
    try {
      const raw = await core.get(core.length - 1);
      const parsed = JSON.parse(raw.toString('utf-8'));
      if (parsed && parsed.publicKey && parsed.privateKey) {
        return {
          publicKey: parsed.publicKey,
          privateKey: parsed.privateKey,
          createdAt: parsed.createdAt ?? null,
        };
      }
    } catch (err) {
      console.warn('[state-store] identity core read failed, regenerating:', err.message);
    }
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const record = JSON.stringify({
    publicKey: jwkHex(publicKey, 'x'),
    privateKey: jwkHex(privateKey, 'd'),
    createdAt: Date.now(),
  });
  await core.append(Buffer.from(record, 'utf-8'));

  return {
    publicKey: jwkHex(publicKey, 'x'),
    privateKey: jwkHex(privateKey, 'd'),
    createdAt: Date.now(),
  };
}

async function loadOrMigrateState(store, userDataDir) {
  const core = store.get({ name: 'kv-state', valueEncoding: 'json' });
  await core.ready();

  const cache = {};
  const len = core.length;
  for (let i = 0; i < len; i++) {
    const evt = await core.get(i);
    if (evt.op === 'set') cache[evt.key] = evt.value;
    else if (evt.op === 'remove') delete cache[evt.key];
  }

  if (len === 0) {
    const legacyPath = path.join(userDataDir, 'state.json');
    if (fs.existsSync(legacyPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
        const entries = Object.entries(data ?? {});
        if (entries.length > 0) {
          const ts = Date.now();
          for (const [key, value] of entries) {
            await core.append({ op: 'set', key, value, ts });
            cache[key] = value;
          }
          fs.unlinkSync(legacyPath);
          console.log(
            `[state-store] migrated ${entries.length} key(s) from state.json into kv-state core`,
          );
        }
      } catch (err) {
        console.warn('[state-store] state.json migration failed:', err.message);
      }
    }
  }

  return cache;
}

module.exports = { createStore };
