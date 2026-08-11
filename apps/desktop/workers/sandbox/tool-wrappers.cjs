// @ts-check
'use strict';

// Host-written PATH shims for sandboxed lesson children, since MCP's transport doesn't inherit npm_config_* and npx would otherwise hit ~/.npm.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isWindows } = require('which-runtime');

const { resolveMcpBins } = require('./mcp-bins.cjs');

function realpathSafe(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

// resolveMcpBins() returns the raw (pre-realpath) node/npm/npx symlinks;
// writeUnixShim below execs realpathSafe(rawTarget) instead, so binding
// the raw symlink path itself is both unnecessary (execDir already grants
// its containing directory) and, on Linux, made bwrap fail outright with
// "Can't create file at ...: No such file or directory" for the deep,
// otherwise-untouched hostedtoolcache path.

/**
 * @param {{ cacheDir: string, tmpDir?: string }} opts
 * @returns {{ dir: string, paths: string[], env: Record<string, string> }}
 */
function createToolWrappers(opts) {
  const cacheDir = opts.cacheDir;
  const dir = fs.mkdtempSync(path.join(opts.tmpDir || os.tmpdir(), 'academy-tool-bin-'));
  fs.mkdirSync(cacheDir, { recursive: true });

  const bins = resolveMcpBins();
  const paths = [];
  const isWin = isWindows;

  function writeUnixShim(name, rawTarget) {
    if (!rawTarget) return;
    // Linux binds by exact path; exec-ing the un-resolved symlink (e.g.
    // .../bin/npx -> ../lib/node_modules/npm/bin/npx-cli.js) only works if
    // that exact symlink path was bound too. appendExtraExec() binds the
    // realpath's package root, so target the realpath directly.
    const target = realpathSafe(rawTarget);
    const shim = path.join(dir, name);
    const body = [
      '#!/bin/sh',
      `export npm_config_cache=${shellQuote(cacheDir)}`,
      `export NPM_CONFIG_CACHE=${shellQuote(cacheDir)}`,
      'export npm_config_update_notifier=false',
      'export npm_config_fund=false',
      'export npm_config_loglevel=error',
      'export NPM_CONFIG_LOGLEVEL=error',
      `exec ${shellQuote(target)} "$@"`,
      '',
    ].join('\n');
    fs.writeFileSync(shim, body, { mode: 0o755 });
    paths.push(shim);
    paths.push(target);
  }

  function writeWinShim(name, target) {
    if (!target) return;
    const shim = path.join(dir, name.endsWith('.cmd') ? name : `${name}.cmd`);
    const body = [
      '@echo off',
      `set "npm_config_cache=${cacheDir.replace(/"/g, '')}"`,
      `set "NPM_CONFIG_CACHE=${cacheDir.replace(/"/g, '')}"`,
      'set "npm_config_update_notifier=false"',
      'set "npm_config_fund=false"',
      'set "npm_config_loglevel=error"',
      'set "NPM_CONFIG_LOGLEVEL=error"',
      `"${target}" %*`,
      '',
    ].join('\r\n');
    fs.writeFileSync(shim, body);
    paths.push(shim);
    paths.push(target);
  }

  if (isWin) {
    writeWinShim('node.exe', bins.node);
    writeWinShim('npm.cmd', bins.npm);
    writeWinShim('npx.cmd', bins.npx);
  } else {
    writeUnixShim('node', bins.node);
    writeUnixShim('npm', bins.npm);
    writeUnixShim('npx', bins.npx);
  }

  const env = {
    npm_config_cache: cacheDir,
    NPM_CONFIG_CACHE: cacheDir,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_loglevel: 'error',
    NPM_CONFIG_LOGLEVEL: 'error',
  };

  return { dir, paths, env };
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

module.exports = {
  createToolWrappers,
};
