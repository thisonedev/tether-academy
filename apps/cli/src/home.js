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

function versionDir(sha) {
  return path.join(versionsDir(), sha);
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

module.exports = { home, versionsDir, versionDir, currentLink, backupsDir, lockPath, repoUrl, branch };
