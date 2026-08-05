'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./proc');
const { runAction } = require('./electron-bridge');
const { home, versionsDir, currentLink, backupsDir, repoUrl, branch } = require('./home');
const { UpdateLock, describeHolder } = require('./update-lock');

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
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ]);
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

// Note: this does not check whether a GUI instance is currently open. That's
// fine for correctness: the swap only lands after a successful build and
// smoke test, and a running process keeps its already-loaded code in memory
// no matter what `current` points to. Still, restart the app after updating
// to pick up the new version.
async function update() {
  const lock = new UpdateLock();
  const acquired = lock.acquire();
  if (!acquired.acquired) {
    console.error(describeHolder(acquired.holder));
    process.exitCode = 1;
    return;
  }

  try {
    const before = currentSha();
    console.log(`-> Backing up profile data (defense in depth)...`);
    const backup = await backupProgressData();
    if (backup) console.log(`   snapshot: ${backup}`);

    const tmpDir = path.join(versionsDir(), `.tmp-${process.pid}-${Date.now()}`);
    fs.mkdirSync(versionsDir(), { recursive: true });
    console.log('-> Fetching latest...');
    run('git', ['clone', '--depth', '1', '--branch', branch(), repoUrl(), tmpDir]);
    const sha = run('git', ['-C', tmpDir, 'rev-parse', 'HEAD'], { quiet: true }).stdout.trim();

    if (sha === before) {
      console.log('Already up to date.');
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    }

    const finalDir = path.join(versionsDir(), sha);
    if (fs.existsSync(finalDir)) fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, finalDir);

    // Everything below happens in `finalDir`, never touching `current`. A
    // failure at any point here leaves the live install completely untouched.
    try {
      console.log('-> Installing dependencies...');
      run('pnpm', ['install'], { cwd: finalDir });
      console.log('-> Building packages...');
      run('pnpm', ['build:packages'], { cwd: finalDir });
      console.log('-> Validating build...');
      run('pnpm', ['--filter', '@tether-academy/desktop', 'typecheck'], { cwd: finalDir });
      await smokeTest(finalDir);
    } catch (err) {
      console.error(`Update validation failed: ${err.message}`);
      console.error(`The current install (${before ?? 'none'}) was left untouched.`);
      fs.rmSync(finalDir, { recursive: true, force: true });
      process.exitCode = 1;
      return;
    }

    const tmpLink = `${currentLink()}.tmp-${process.pid}`;
    fs.symlinkSync(finalDir, tmpLink, 'dir');
    fs.renameSync(tmpLink, currentLink()); // atomic swap

    pruneOldVersions(sha);
    console.log(`\nUpdated ${before ? `${before.slice(0, 12)} -> ` : ''}${sha.slice(0, 12)}.`);
  } finally {
    lock.release();
  }
}

module.exports = { update };
