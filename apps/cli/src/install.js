'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./proc');
const { home, versionsDir, versionDir, currentLink, repoUrl, branch, linkType, shimDir, shimPath: shimFilePath } = require('./home');
const { printBanner } = require('./splash');

function writeShim(targetEntry) {
  const binDir = shimDir();
  const shimPath = shimFilePath();
  fs.mkdirSync(binDir, { recursive: true });
  if (process.platform === 'win32') {
    // %~dp0-relative would break once versions/<sha> gets pruned by an
    // update; targetEntry is already the live `current` symlink/junction.
    fs.writeFileSync(shimPath, `@node "${targetEntry}" %*\r\n`);
  } else {
    fs.writeFileSync(shimPath, `#!/usr/bin/env bash\nexec node "${targetEntry}" "$@"\n`, { mode: 0o755 });
  }
  return { shimPath, onPath: (process.env.PATH || '').split(path.delimiter).includes(binDir) };
}

async function install() {
  printBanner('Installing Tether Academy...');
  fs.mkdirSync(versionsDir(), { recursive: true });
  const tmpDir = path.join(versionsDir(), `.tmp-${process.pid}-${Date.now()}`);

  console.log(`-> Cloning ${repoUrl()} (${branch()})...`);
  run('git', ['clone', '--depth', '1', '--branch', branch(), repoUrl(), tmpDir], { quiet: true });

  const sha = run('git', ['-C', tmpDir, 'rev-parse', 'HEAD'], { quiet: true }).stdout.trim();
  const finalDir = versionDir(sha);
  if (fs.existsSync(finalDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  else fs.renameSync(tmpDir, finalDir);

  console.log('-> Installing dependencies...');
  run('pnpm', ['install'], { cwd: finalDir });
  console.log('-> Building (this can take a minute or two)...');
  run('pnpm', ['build'], { cwd: finalDir });

  const tmpLink = `${currentLink()}.tmp-${process.pid}`;
  fs.symlinkSync(finalDir, tmpLink, linkType());
  fs.renameSync(tmpLink, currentLink()); // atomic same-directory rename, POSIX and Windows both

  const entry = path.join(currentLink(), 'apps', 'cli', 'bin', 'tether-academy.js');
  const { shimPath, onPath } = writeShim(entry);

  console.log(`\ntether-academy installed at ${home()} (version ${sha.slice(0, 12)})`);
  console.log(`Shim written to ${shimPath}`);
  if (!onPath) {
    console.log(
      process.platform === 'win32'
        ? `Add it to your PATH: setx PATH "%PATH%;${shimDir()}"`
        : `Add it to your PATH: export PATH="$HOME/.local/bin:$PATH"`,
    );
  }
  console.log('Run `tether-academy start` to launch the app.');
}

module.exports = { install };
