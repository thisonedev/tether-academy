// @ts-check
'use strict';

// Host-written shims put first on PATH for sandboxed lesson children.
// MCP StdioClientTransport only inherits HOME/PATH/USER/… — not npm_config_* —
// so `npx -y …` would still hit ~/.npm without these wrappers.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isWindows } = require('which-runtime');

const { mcpExecPaths, resolveMcpBins } = require('./mcp-bins.cjs');

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

  function writeUnixShim(name, target) {
    if (!target) return;
    const shim = path.join(dir, name);
    const body = [
      '#!/bin/sh',
      `export npm_config_cache=${shellQuote(cacheDir)}`,
      `export NPM_CONFIG_CACHE=${shellQuote(cacheDir)}`,
      'export npm_config_update_notifier=false',
      'export npm_config_fund=false',
      // Hide deprecation/warn noise (e.g. whatwg-encoding) in lesson UI.
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

  // Also allow any other resolved mcp paths (e.g. realpath variants).
  for (const p of mcpExecPaths()) {
    if (p && !paths.includes(p)) paths.push(p);
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
