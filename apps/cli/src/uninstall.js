'use strict';

// Removes tether-academy from your device.
//   default          remove the app, CLI shim, and backups; ask about models/
//                     output/progress/identity interactively (TTY) or leave
//                     them alone (non-interactive, no flags)
//   --purge          also remove models, output, progress, and identity
//   --models/--output/--progress/--identity   opt a category in without --purge

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { home, versionsDir, currentLink, backupsDir, lockPath, shimPath } = require('./home');
const { checkboxPrompt } = require('./checkbox-prompt');

function secretsDir() {
  return path.join(home(), 'keys');
}

function appStateDir() {
  const h = os.homedir();
  if (process.platform === 'darwin') return path.join(h, 'Library', 'Application Support', 'Tether Academy');
  if (process.platform === 'win32') return path.join(h, 'AppData', 'Roaming', 'Tether Academy');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(h, '.config'), 'Tether Academy');
}

function modelsDir() {
  return path.join(os.homedir(), '.qvac', 'models');
}

// Mirrors apps/desktop/shared/lesson-output.cjs's lessonHomeDir: Documents/
// Tether Academy/output if Documents exists, else ~/Tether Academy/output.
function outputDir() {
  const h = os.homedir();
  const documents = path.join(h, 'Documents');
  const base = fs.existsSync(documents) ? documents : h;
  return path.join(base, 'Tether Academy', 'output');
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
function plan() {
  const targets = [
    { path: versionsDir(), label: 'checkouts + builds' },
    { path: path.join(home(), 'app-bundle'), label: 'desktop app' },
    { path: currentLink(), label: 'active version symlink' },
    { path: lockPath(), label: 'update lock' },
    { path: shimPath(), label: 'CLI shim' },
    { path: backupsDir(), label: 'profile data backups' },
  ];
  return targets.filter((t) => exists(t.path));
}

// Your data, as opposed to the app itself. Identity absorbs the profile keys
// (previously only reachable via --purge on their own). Progress also caches
// in Electron's localStorage, read before corestore, so both need wiping.
function extrasCatalog() {
  const state = appStateDir();
  return [
    { id: 'models', label: 'Downloaded models', paths: [modelsDir()] },
    { id: 'output', label: 'Lesson output files', paths: [outputDir()] },
    {
      id: 'progress',
      label: 'Progress & settings',
      paths: [
        path.join(state, 'corestore'),
        path.join(state, 'Local Storage'),
        path.join(state, 'Session Storage'),
        path.join(state, 'IndexedDB'),
      ],
    },
    {
      id: 'identity',
      label: 'Identity',
      paths: [path.join(state, 'identity-v3.json'), path.join(state, 'profile-publish-v1.json'), secretsDir()],
    },
  ]
    .map((e) => ({ ...e, paths: e.paths.filter(exists) }))
    .filter((e) => e.paths.length > 0);
}

function categorySize(category) {
  return category.paths.reduce((sum, p) => sum + dirSize(p), 0);
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

// Column math shared between the static "Will remove:" list and the
// interactive checklist below it, so their size columns line up on the same
// terminal column despite the two sections having different row shapes.
const COLUMN_GAP = 4;

function buildColumns(targets, extras) {
  const col2Start =
    Math.max(...targets.map((t) => 2 + t.path.length)) + COLUMN_GAP;
  const willRemoveLines = targets.map((t) => {
    const left = t.path.padEnd(col2Start - 2) + t.label;
    return { left: `  ${left}`, size: human(dirSize(t.path)) };
  });
  const checklistPrefixLines = extras.map((e) => ({
    left: `  X X ${e.label}`,
    size: human(categorySize(e)),
  }));
  const endColumn =
    Math.max(...[...willRemoveLines, ...checklistPrefixLines].map((r) => r.left.length + r.size.length)) +
    COLUMN_GAP;
  return { willRemoveLines, endColumn };
}

async function uninstall(opts = {}) {
  const { purge = false, yes = false, models, output, progress, identity } = opts;

  console.log('Removing Tether Academy...');
  const targets = plan();
  const extras = extrasCatalog();

  if (targets.length === 0 && extras.length === 0) {
    console.log('Nothing to remove: no install found.');
    return;
  }

  const { willRemoveLines, endColumn } = buildColumns(targets, extras);
  if (targets.length > 0) {
    console.log('Will remove:');
    for (const { left, size } of willRemoveLines) {
      const pad = Math.max(endColumn - left.length - size.length, 1);
      console.log(left + ' '.repeat(pad) + size);
    }
  }

  const explicitFlag = { models, output, progress, identity };
  const hasExplicitFlags = Object.values(explicitFlag).some((v) => v !== undefined);

  let selectedIds;
  if (extras.length === 0) {
    selectedIds = new Set();
  } else if (!process.stdin.isTTY || yes || purge || hasExplicitFlags) {
    // Non-interactive: nothing extra by default, unless --purge or an
    // explicit category flag says otherwise.
    selectedIds = new Set(
      extras.filter((e) => (explicitFlag[e.id] !== undefined ? explicitFlag[e.id] : purge)).map((e) => e.id),
    );
  } else {
    console.log('\nAlso remove:');
    console.log('  space to toggle, enter to confirm\n');
    const items = extras.map((e) => ({
      label: e.label,
      size: human(categorySize(e)),
      // Models/output are easy to regenerate; progress/identity aren't.
      checked: e.id === 'models' || e.id === 'output',
    }));
    let checked;
    try {
      checked = await checkboxPrompt(items, { endColumn });
    } catch {
      console.log('Aborted. Nothing was removed.');
      return;
    }
    selectedIds = new Set(extras.filter((_, i) => checked[i]).map((e) => e.id));
  }

  const selectedExtras = extras.filter((e) => selectedIds.has(e.id));
  const allRemovalPaths = [...targets.map((t) => t.path), ...selectedExtras.flatMap((e) => e.paths)];

  if (allRemovalPaths.length === 0) {
    console.log('\nNothing selected. Nothing was removed.');
    return;
  }

  if (!yes) {
    const ok = await confirm('\nProceed? [y/N] ');
    if (!ok) {
      console.log('Aborted. Nothing was removed.');
      return;
    }
  }

  const totalBytes = allRemovalPaths.reduce((s, p) => s + dirSize(p), 0);

  console.log('\nRemoving...');
  for (const p of allRemovalPaths) {
    fs.rmSync(p, { recursive: true, force: true });
  }

  // Only prune home() itself once it's empty, so a run that leaves keys/
  // behind (identity not selected) doesn't quietly take the directory with it.
  try {
    if (fs.readdirSync(home()).length === 0) fs.rmdirSync(home());
  } catch {
    // non-empty or already gone; either is fine
  }

  console.log(
    `\n✓ Removed ${allRemovalPaths.length} path${allRemovalPaths.length === 1 ? '' : 's'} (${human(totalBytes)} freed).`,
  );
  console.log(`Reinstall with: ${reinstallCommand()}`);
}

function reinstallCommand() {
  if (process.platform === 'win32') return 'irm https://tetheracademy.cc/install.ps1 | iex';
  return 'curl -fsSL https://tetheracademy.cc/install.sh | sh';
}

module.exports = { uninstall };
