'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { run, runQuiet, ensureCommand } = require('./proc');
const { runAction } = require('./electron-bridge');
const {
  home,
  versionsDir,
  versionDir,
  pnpmVirtualStoreDir,
  currentLink,
  backupsDir,
  repoUrl,
  branch,
  linkType,
  swapCurrentLink,
} = require('./home');
const { UpdateLock, describeHolder } = require('./update-lock');

// See pnpmVirtualStoreDir() in home.js: keeps pnpm's hashed store names off
// the long versions/<sha>/ prefix so native addon paths stay under Windows' MAX_PATH.
function writeWindowsNpmrc(dir) {
  if (process.platform !== 'win32') return;
  const storeDir = pnpmVirtualStoreDir().split(path.sep).join('/');
  fs.writeFileSync(path.join(dir, '.npmrc'), `virtual-store-dir=${storeDir}\n`, { flag: 'a' });
}

const KEEP_VERSIONS = 3;
const KEEP_BACKUPS = 3;
const SMOKE_TIMEOUT_MS = 30_000;

function currentSha() {
  try {
    return fs.readlinkSync(currentLink()).split(path.sep).pop();
  } catch {
    return null;
  }
}

function semverFor(checkoutDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(checkoutDir, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

async function backupProgressData() {
  const target = currentLink();
  if (!fs.existsSync(target)) return null;
  const desktopDir = path.join(target, 'apps', 'desktop');
  let userData;
  try {
    const res = await withTimeout(runAction(desktopDir, 'paths'), SMOKE_TIMEOUT_MS);
    if (!res.ok) return null;
    userData = res.result.userData;
  } catch {
    return null; // best-effort safety net; never block the update on this
  }
  if (!userData || !fs.existsSync(userData)) return null;

  const dest = path.join(backupsDir(), String(Date.now()));
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(userData, path.join(dest, 'userData'), { recursive: true, errorOnExist: false });

  const entries = fs.readdirSync(backupsDir()).sort();
  for (const stale of entries.slice(0, Math.max(0, entries.length - KEEP_BACKUPS))) {
    fs.rmSync(path.join(backupsDir(), stale), { recursive: true, force: true });
  }
  return dest;
}

function withTimeout(promise, ms) {
  // Promise.race doesn't cancel the loser; an uncleared timer here kept
  // running for the full `ms` after `promise` won, hanging the process.
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function smokeTest(versionDir) {
  const desktopDir = path.join(versionDir, 'apps', 'desktop');
  const scratchStorage = path.join(require('node:os').tmpdir(), `ta-smoke-${process.pid}-${Date.now()}`);
  try {
    const res = await withTimeout(
      runAction(desktopDir, 'device-info', { storage: scratchStorage }),
      SMOKE_TIMEOUT_MS,
    );
    if (!res.ok) throw new Error(res.error || 'smoke test failed');
  } finally {
    fs.rmSync(scratchStorage, { recursive: true, force: true });
  }
}

function pruneOldVersions(keepSha) {
  const dir = versionsDir();
  if (!fs.existsSync(dir)) return;
  const entries = fs
    .readdirSync(dir)
    .filter((name) => name !== keepSha && !name.startsWith('.'))
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const stale of entries.slice(KEEP_VERSIONS - 1)) {
    fs.rmSync(path.join(dir, stale.name), { recursive: true, force: true });
  }
}

// Doesn't check whether the GUI is open: the swap only happens after a
// successful build+smoke test, and a running process keeps its old code in
// memory regardless. Restart the app afterward to pick up the new version.
async function update() {
  ensureCommand('git', 'https://git-scm.com');
  ensureCommand('node', 'https://nodejs.org');

  const lock = new UpdateLock();
  const acquired = lock.acquire();
  if (!acquired.acquired) {
    console.error(describeHolder(acquired.holder));
    process.exitCode = 1;
    return;
  }

  try {
    const before = currentSha();
    console.log(`→ Backing up profile data...`);
    const backup = await backupProgressData();
    if (backup) console.log(`  ✓ Backed up profile data`);

    const tmpDir = path.join(versionsDir(), `.tmp-${process.pid}-${Date.now()}`);
    fs.mkdirSync(versionsDir(), { recursive: true });
    console.log('→ Fetching updates...');
    run('git', ['clone', '--depth', '1', '--branch', branch(), repoUrl(), tmpDir], { quiet: true });
    const sha = run('git', ['-C', tmpDir, 'rev-parse', 'HEAD'], { quiet: true }).stdout.trim();

    // before is a directory name read off disk (already short, see versionDir);
    // sha is the freshly computed full one, so compare on the same slice.
    if (sha.slice(0, 12) === before) {
      console.log('✓ Already up to date!');
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    }

    const finalDir = versionDir(sha);
    if (fs.existsSync(finalDir)) fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, finalDir);
    writeWindowsNpmrc(finalDir);

    // Everything below happens in `finalDir`, never touching `current`. A
    // failure at any point here leaves the live install completely untouched.
    try {
      console.log('→ Installing dependencies...');
      await runQuiet('pnpm', ['install'], { cwd: finalDir });
      console.log('  ✓ Dependencies installed');
      console.log('→ Building (this can take a minute or two)...');
      await runQuiet('pnpm', ['build'], { cwd: finalDir });
      console.log('  ✓ Build complete');
      console.log('→ Validating build...');
      await runQuiet('pnpm', ['--filter', '@tether-academy/desktop', 'typecheck'], { cwd: finalDir });
      console.log('  ✓ Build validated');
      await smokeTest(finalDir);
      console.log('  ✓ Smoke test passed');
    } catch (err) {
      console.error(`Update validation failed: ${err.message}`);
      console.error(`The current install (${before ?? 'none'}) was left untouched.`);
      fs.rmSync(finalDir, { recursive: true, force: true });
      process.exitCode = 1;
      return;
    }

    const tmpLink = `${currentLink()}.tmp-${process.pid}`;
    fs.symlinkSync(finalDir, tmpLink, linkType());
    const beforeDir = currentLink();
    swapCurrentLink(tmpLink);

    pruneOldVersions(sha.slice(0, 12));
    const beforeVersion = before ? semverFor(beforeDir) : null;
    const afterVersion = semverFor(finalDir);
    let summary;
    if (beforeVersion && afterVersion && beforeVersion !== afterVersion) {
      summary = `${beforeVersion} → ${afterVersion}`;
    } else if (afterVersion) {
      summary = afterVersion;
    } else {
      summary = `${before ? `${before.slice(0, 12)} → ` : ''}${sha.slice(0, 12)}`;
    }
    console.log(`\n✓ Updated ${summary}.`);
  } finally {
    lock.release();
  }
}

module.exports = { update };
