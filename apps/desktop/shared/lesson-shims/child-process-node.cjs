'use strict';

// What a lesson gets for `node:child_process` under real Node. __academyExit
// calls process.exit() directly, bypassing the open handle that would keep
// an event-driven lesson (spawn ffmpeg, never await again) alive otherwise.
const cp = require('child_process');

const liveChildren = new Set();

function track(child) {
  if (!child || typeof child.on !== 'function') return child;
  liveChildren.add(child);
  const drop = () => liveChildren.delete(child);
  child.on('exit', drop);
  child.on('close', drop);
  child.on('error', drop);
  return child;
}

function spawn(...args) {
  return track(cp.spawn(...args));
}

// Static assignments, not `...cp`: cjs-module-lexer (what makes a CJS
// module's named exports importable from ESM) can't resolve a spread.
exports.ChildProcess = cp.ChildProcess;
exports.exec = cp.exec;
exports.execFile = cp.execFile;
exports.execFileSync = cp.execFileSync;
exports.execSync = cp.execSync;
exports.fork = cp.fork;
exports.spawn = spawn;
exports.spawnSync = cp.spawnSync;
// Read by the runner preamble, which cannot see this module's own state.
exports.__academyLiveChildren = () => liveChildren.size;
