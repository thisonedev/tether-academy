'use strict';

const { runInherit } = require('./proc');
const { desktopDir } = require('./desktop-dir');
const { ensureBrandedApp } = require('./mac-app-bundle');
const { printBanner } = require('./splash');

function start({ storage } = {}) {
  printBanner('Starting Tether Academy...');
  // macOS: launch a rebranded copy of Electron.app so the dock/menu bar show
  // "Tether Academy" from process start, not just after app.setName() runs
  // (see mac-app-bundle.js). Falls back to plain Electron elsewhere.
  const electronPath = ensureBrandedApp(desktopDir()) ?? require('electron');
  const args = [desktopDir()];
  if (storage) args.push('--storage', storage);
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  const child = runInherit(electronPath, args, { env });
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
}

module.exports = { start };
