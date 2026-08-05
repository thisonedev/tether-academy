'use strict';

// Drives apps/desktop/electron/cli-entry.js: a headless Electron process (no
// BrowserWindow) that runs one read-only action (device-info, paths) for
// `update`'s pre-swap smoke test and pre-update backup.
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

function cliEntryPath(desktopDir) {
  return path.join(desktopDir, 'electron', 'cli-entry.js');
}

/**
 * @param {string} desktopDir absolute path to the apps/desktop checkout to run
 * @param {string} action
 * @param {{ storage?: string }} [opts]
 */
function runAction(desktopDir, action, opts = {}) {
  const electronPath = require('electron'); // resolves to the binary path outside a running Electron process
  const args = [cliEntryPath(desktopDir), '--action', action];
  if (opts.storage) args.push('--storage', opts.storage);

  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, args, {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
    });

    let settled = null;
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'result') settled = msg;
      } catch {
        // stray non-protocol stdout (e.g. a warning); ignore
      }
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (settled) return resolve(settled);
      reject(new Error(`tether-academy: action "${action}" exited ${code} with no result`));
    });
  });
}

module.exports = { runAction };
