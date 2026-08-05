'use strict';

// Every external command in this CLI goes through here: argv arrays only,
// `shell` never set to true, so nothing from a sha or path can be
// interpreted by a shell even if it contains `; rm -rf ~` etc.
const { spawnSync, spawn } = require('node:child_process');

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: opts.quiet ? 'pipe' : 'inherit',
    encoding: 'utf8',
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
