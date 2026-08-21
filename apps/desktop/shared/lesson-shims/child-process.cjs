// @ts-check
'use strict';

// What a lesson gets for `node:child_process` under Bare. Re-exports
// bare-subprocess with two corrections, so lesson source can stay identical to
// the SDK example it comes from instead of carrying academy-only workarounds.

const subprocess = require('bare-subprocess');
const fs = require('bare-fs');
const os = require('bare-os');
const path = require('bare-path');

// Async children the lesson still has open. A mic lesson registers its
// handlers and returns, so the top level settling says nothing about whether
// the lesson is finished; under Node the open handle keeps it running.
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

function spawn(file, args, opts) {
  return track(subprocess.spawn(file, args, opts));
}

function normalizeStdio(stdio) {
  if (Array.isArray(stdio)) return [...stdio];
  if (typeof stdio === 'string') return [stdio, stdio, stdio];
  return ['pipe', 'pipe', 'pipe'];
}

// bare-subprocess hands `input` to its native binding but never closes the
// child's stdin, so anything reading to EOF blocks forever (ffplay never
// returns, which reads as a broken lesson). Staging the bytes in a file and
// passing the descriptor gives the child a real end of input.
function spawnSync(file, args, opts) {
  if (!Array.isArray(args) && args !== null && typeof args === 'object') {
    opts = args;
    args = [];
  }
  // bare-subprocess never reads `timeout`, and the call blocks inside its
  // native binding where no JS timer can reach it. Saying so beats returning
  // as though the limit had been applied.
  if (opts && opts.timeout != null) {
    throw new Error(
      'spawnSync does not support `timeout` on this runtime. Use spawn() with a timer that kills the child.',
    );
  }
  if (!opts || opts.input == null) return subprocess.spawnSync(file, args ?? [], opts);

  const { input, ...rest } = opts;
  const name = `academy-stdin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const staged = path.join(os.tmpdir(), name);
  let fd;
  try {
    fs.writeFileSync(staged, input);
    fd = fs.openSync(staged, 'r');
    const stdio = normalizeStdio(rest.stdio);
    stdio[0] = fd;
    return subprocess.spawnSync(file, args ?? [], { ...rest, stdio });
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(staged);
    } catch {}
  }
}

module.exports = {
  ...subprocess,
  spawn,
  spawnSync,
  // Read by the runner preamble, which cannot see this module's own state.
  __academyLiveChildren: () => liveChildren.size,
};
