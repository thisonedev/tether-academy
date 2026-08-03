'use strict';

const test = require('brittle');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const main = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8');
const registry = require(path.join(root, 'shared/ipc-channels.cjs'));

// Match `handle('channel'` but not `protocol.handle('scheme'` — only the
// IPC wrapper registers IPC channels, not the protocol handler.
const registered = [...main.matchAll(/(?<![\w.])handle\('([^']+)'/g)].map(
  (match) => match[1],
);
const dynamic = [...main.matchAll(/handle\(`([^`$]+)\$\{[^}]+\}([^`]*)`/g)].map(
  (match) => `${match[1]}${match[2]}`,
);

test('ipc contract keeps literal handlers in the registry', (t) => {
  for (const channel of registered) t.ok(Object.hasOwn(registry, channel), channel);
  t.ok(registered.length > 0, 'found wrapped handlers');
  t.ok(dynamic.includes('pear:worker:writeIPC:'), 'found dynamic worker handler');
});

test('ipc contract leaves only the wrapper and academy:run registrations', (t) => {
  // The wrapper's body plus the academy:run handler are the only direct
  // ipcMain.handle calls. academy:run stays manual because it formats parse
  // errors into a string the renderer can print; the wrapper would surface
  // them as rejections. protocol.handle('academy', ...) is the protocol
  // scheme, not an IPC channel, and is counted separately.
  const count = (main.match(/ipcMain\.handle\(/g) || []).length;
  t.is(count, 2);
});

test('ipc contract registry schemas resolve to validation exports', async (t) => {
  const validation = await import('@academy/validation');
  for (const [channel, schemaName] of Object.entries(registry)) {
    if (channel === 'pkg' || channel.endsWith(':') || channel === 'PEAR_WORKER_PREFIX') continue;
    if (schemaName !== null) t.ok(schemaName in validation, `${channel}: ${schemaName}`);
  }
});

test('ipc contract has no stale literal registry entries', (t) => {
  for (const channel of Object.keys(registry)) {
    if (channel === 'pkg' || channel.endsWith(':') || channel === 'PEAR_WORKER_PREFIX') continue;
    t.ok(registered.includes(channel) || channel === 'academy:run', channel);
  }
});
