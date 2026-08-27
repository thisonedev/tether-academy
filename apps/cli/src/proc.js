'use strict';

// Argv arrays only, `shell` never true on POSIX, so nothing in a sha or
// path is shell-interpretable. Windows needs it: a bare `pnpm`/`git`
// resolves to a .cmd shim spawnSync can't run without shell:true.
const { spawnSync, spawn } = require('node:child_process');

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: opts.quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...opts,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = opts.quiet ? (result.stderr || result.stdout || '').trim() : '';
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${result.status})${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function runInherit(cmd, args, opts = {}) {
  return spawn(cmd, args, { stdio: 'inherit', ...opts });
}

module.exports = { run, runInherit };
