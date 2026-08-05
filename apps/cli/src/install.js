'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { run } = require('./proc');
const { home, versionsDir, currentLink, repoUrl, branch } = require('./home');

function writeShim(targetEntry) {
  const binDir = path.join(os.homedir(), '.local', 'bin');
  const shimPath = path.join(binDir, 'tether-academy');
  fs.mkdirSync(binDir, { recursive: true });
  const script = `#!/usr/bin/env bash\nexec node "${targetEntry}" "$@"\n`;
  fs.writeFileSync(shimPath, script, { mode: 0o755 });
  return { shimPath, onPath: (process.env.PATH || '').split(path.delimiter).includes(binDir) };
}

async function install() {
  fs.mkdirSync(versionsDir(), { recursive: true });
  const tmpDir = path.join(versionsDir(), `.tmp-${process.pid}-${Date.now()}`);

  console.log(`-> Cloning ${repoUrl()} (${branch()})...`);
  run('git', ['clone', '--depth', '1', '--branch', branch(), repoUrl(), tmpDir]);

  const sha = run('git', ['-C', tmpDir, 'rev-parse', 'HEAD'], { quiet: true }).stdout.trim();
  const finalDir = path.join(versionsDir(), sha);
  if (fs.existsSync(finalDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  else fs.renameSync(tmpDir, finalDir);

  console.log('-> Installing dependencies...');
  run('pnpm', ['install'], { cwd: finalDir });
  console.log('-> Building packages...');
  run('pnpm', ['build:packages'], { cwd: finalDir });

  const tmpLink = `${currentLink()}.tmp-${process.pid}`;
  fs.symlinkSync(finalDir, tmpLink, 'dir');
  fs.renameSync(tmpLink, currentLink()); // atomic on POSIX: same-directory rename

  const entry = path.join(currentLink(), 'apps', 'cli', 'bin', 'tether-academy.js');
  const { shimPath, onPath } = writeShim(entry);

  console.log(`\ntether-academy installed at ${home()} (version ${sha.slice(0, 12)})`);
  console.log(`Shim written to ${shimPath}`);
  if (!onPath) {
    console.log(`Add it to your PATH: export PATH="$HOME/.local/bin:$PATH"`);
  }
  console.log('Run `tether-academy start` to launch the app.');
}

module.exports = { install };
