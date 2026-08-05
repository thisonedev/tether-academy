// Headless Electron entry for `tether-academy update`'s pre-swap validation
// and backup steps. No BrowserWindow is created.
//
// electron cli-entry.js --action <device-info|paths> [--storage <dir>]
// stdout: one JSON line, {"type":"result","ok":true|false,...}
'use strict';

const { app } = require('electron');
const path = require('node:path');
const { getDeviceInfo } = require('./device.cjs');

function parseArgs(argv) {
  const out = { action: null, storage: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--action') out.action = argv[++i];
    else if (argv[i] === '--storage') out.storage = argv[++i];
  }
  return out;
}

function emit(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function runAction(action) {
  if (action === 'device-info') return getDeviceInfo();
  // Lets `update` locate this profile's userData dir (e.g. to snapshot it
  // before swapping) without touching it.
  if (action === 'paths') return { userData: app.getPath('userData') };
  throw new Error(`unknown CLI action: ${action}`);
}

app.whenReady().then(async () => {
  const { action, storage } = parseArgs(process.argv.slice(2));
  if (storage) app.setPath('userData', path.resolve(storage));
  if (!action) {
    emit({ type: 'result', ok: false, error: 'missing --action' });
    app.exit(1);
    return;
  }
  try {
    const result = await runAction(action);
    emit({ type: 'result', ok: true, result });
    app.exit(0);
  } catch (err) {
    emit({ type: 'result', ok: false, error: err?.message ?? String(err) });
    app.exit(1);
  }
});
