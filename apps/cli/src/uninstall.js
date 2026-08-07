'use strict';

// Removes tether-academy from your device. Two modes:
//   default        remove the academy app, CLI shim, and profile backups, but keep the profile key(s)
//   --purge        remove everything, including profile key(s)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { home, versionsDir, currentLink, backupsDir, lockPath } = require('./home');
const { printSplash } = require('./splash');

function shimPath() {
  return path.join(os.homedir(), '.local', 'bin', 'tether-academy');
}

function secretsDir() {
  return path.join(home(), 'keys');
}

function dirSize(target) {
  let total = 0;
  const stack = [target];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue; // never follow: `current` points into versions/
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(cur)) stack.push(path.join(cur, name));
    } else {
      total += st.size;
    }
  }
  return total;
}

function human(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}M`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
  return `${bytes}B`;
}

function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// Everything install/update writes, in the order it's safe to remove.
function plan({ purge }) {
  const targets = [
    { path: versionsDir(), label: 'checkouts + builds' },
    { path: path.join(home(), 'app-bundle'), label: 'rebranded Electron.app' },
    { path: currentLink(), label: 'active version symlink' },
    { path: lockPath(), label: 'update lock' },
    { path: shimPath(), label: 'CLI shim' },
    { path: backupsDir(), label: 'profile data backups' },
  ];
  if (purge) targets.push({ path: secretsDir(), label: 'profile encryption keys' });
  return targets.filter((t) => exists(t.path));
}

function confirm(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function uninstall({ purge = false, yes = false } = {}) {
  printSplash('uninstalling');

  const targets = plan({ purge });
  if (targets.length === 0) {
    console.log('Nothing to remove: no install found.');
    return;
  }

  console.log('Will remove:');
  for (const t of targets) {
    console.log(`  ${t.path}  (${t.label}, ${human(dirSize(t.path))})`);
  }

  const keys = secretsDir();
  if (!purge && exists(keys)) {
    console.log(`\nKeeping:\n  ${keys}  (profile encryption keys, ${human(dirSize(keys))})`);
    console.log('  Re-run with --purge to remove these too.');
  }

  // safeStorage (OS keychain) is the primary secret store; the keys dir only
  // holds the non-keychain fallback. Neither lives in a path we should delete.
  if (purge) {
    console.log('\nNot removed (delete by hand if you want a truly clean slate):');
    console.log(`  ${appStateDir()}  (app data: identity record, progress, corestore)`);
    console.log('  OS keychain entry "Tether Academy" (Keychain Access on macOS)');
  }

  if (!yes) {
    const ok = await confirm('\nProceed? [y/N] ');
    if (!ok) {
      console.log('Aborted. Nothing was removed.');
      return;
    }
  }

  for (const t of targets) {
    fs.rmSync(t.path, { recursive: true, force: true });
  }

  // Only prune home() itself once it's empty, so a --purge=false run that
  // leaves keys/ behind doesn't quietly take the directory with it.
  try {
    if (fs.readdirSync(home()).length === 0) fs.rmdirSync(home());
  } catch {
    // non-empty or already gone; either is fine
  }

  console.log(`\nRemoved ${targets.length} path${targets.length === 1 ? '' : 's'}.`);
  console.log('Reinstall with: curl -fsSL https://tetheracademy.cc/install.sh | sh');
}

function appStateDir() {
  const h = os.homedir();
  if (process.platform === 'darwin') return path.join(h, 'Library', 'Application Support', 'Tether Academy');
  if (process.platform === 'win32') return path.join(h, 'AppData', 'Roaming', 'Tether Academy');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(h, '.config'), 'Tether Academy');
}

module.exports = { uninstall };
