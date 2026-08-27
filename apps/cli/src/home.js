'use strict';

// ~/.tether-academy (same shape as Hermes' ~/.hermes):
//   versions/<sha>/       full checkout + build for one commit
//   current                symlink -> versions/<sha>, the active version
//   backups/<ts>/          pre-update snapshots of the app's userData dir
//   .update-in-progress    update lock (pid + started-at)
const os = require('node:os');
const path = require('node:path');

function home() {
  const override = process.env.TETHER_ACADEMY_HOME;
  return override && override.trim() ? path.resolve(override) : path.join(os.homedir(), '.tether-academy');
}

function versionsDir() {
  return path.join(home(), 'versions');
}

// Short, not full 40-char sha: pnpm's .pnpm store already nests peer-dep-hashed
// directory names deep enough that the full sha here pushes real file paths
// (e.g. bare-runtime's platform binary) past Windows' 260-char MAX_PATH.
function versionDir(sha) {
  return path.join(versionsDir(), sha.slice(0, 12));
}

function currentLink() {
  return path.join(home(), 'current');
}

function backupsDir() {
  return path.join(home(), 'backups');
}

function lockPath() {
  return path.join(home(), '.update-in-progress');
}

// Real symlinks need admin or dev mode on Windows; junctions need neither
// and fs.symlinkSync's 'junction' type has covered them since Node 6.
function linkType() {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

// POSIX gets a bash shim on PATH already searched by convention (~/.local/bin).
// Windows has no such convention, so this uses its own per-app bin dir instead.
function shimDir() {
  return process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Local', 'tether-academy', 'bin')
    : path.join(os.homedir(), '.local', 'bin');
}

function shimPath() {
  return path.join(shimDir(), process.platform === 'win32' ? 'tether-academy.cmd' : 'tether-academy');
}

function repoUrl() {
  const override = process.env.TETHER_ACADEMY_REPO;
  // HTTPS, not SSH: this is what a fresh machine with no deploy key clones
  // (the repo is public), which is the common case for `install`/`update`.
  return override && override.trim() ? override : 'https://github.com/thisonedev/tether-academy.git';
}

// Overrides the branch `install`/`update` track (default: master). Combine
// with TETHER_ACADEMY_REPO=<local path> to test a not-yet-merged branch.
function branch() {
  const override = process.env.TETHER_ACADEMY_BRANCH;
  return override && override.trim() ? override : 'master';
}

module.exports = { home, versionsDir, versionDir, currentLink, backupsDir, lockPath, repoUrl, branch, linkType, shimDir, shimPath };
