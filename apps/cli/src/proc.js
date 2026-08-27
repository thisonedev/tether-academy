'use strict';

// Argv arrays only, `shell` never true on POSIX, so nothing in a sha or
// path is shell-interpretable. Windows needs it: a bare `pnpm`/`git`
// resolves to a .cmd shim spawnSync can't run without shell:true.
const { spawnSync, spawn } = require('node:child_process');

// shell:true + an args array is exactly what DEP0190 warns about, which is
// the whole reason it's set above: expected on every Windows run, not a bug.
// A 'warning' listener doesn't stop Node's own default stderr print; only
// this does.
process.noDeprecation = true;

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

// spawnSync blocks the event loop for the whole command, so a quiet run()
// can't also print a heartbeat. This uses async spawn so a "still working"
// dot can print while output stays hidden, surfaced in full only on failure.
function runQuiet(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: process.platform === 'win32', ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let printedDots = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const heartbeat = setInterval(() => {
      process.stdout.write('.');
      printedDots = true;
    }, 10000);
    child.on('error', (err) => {
      clearInterval(heartbeat);
      reject(err);
    });
    child.on('close', (code) => {
      clearInterval(heartbeat);
      if (printedDots) process.stdout.write('\n');
      if (code !== 0) {
        const detail = (stderr || stdout).trim();
        reject(new Error(`${cmd} ${args.join(' ')} failed (exit ${code})${detail ? `: ${detail}` : ''}`));
        return;
      }
      resolve({ stdout, stderr, status: code });
    });
  });
}

function runInherit(cmd, args, opts = {}) {
  return spawn(cmd, args, { stdio: 'inherit', ...opts });
}

module.exports = { run, runQuiet, runInherit };
