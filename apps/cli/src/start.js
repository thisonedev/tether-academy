'use strict';

const { runInherit } = require('./proc');
const { desktopDir } = require('./desktop-dir');

function start({ storage } = {}) {
  const electronPath = require('electron');
  const args = [desktopDir()];
  if (storage) args.push('--storage', storage);
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  const child = runInherit(electronPath, args, { env });
  return new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
}

module.exports = { start };
