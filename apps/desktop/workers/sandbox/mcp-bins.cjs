// @ts-check
'use strict';

// Host-resolved Node/npm/npx paths for sandboxed MCP lesson children.
// Lessons spawn `npx -y @…` via StdioClientTransport; seatbelt only allows
// process-exec of absolute paths we inject at wrap time.

const fs = require('fs');
const path = require('path');
const { isWindows } = require('which-runtime');

const { resolveExecName } = require('./capabilities.cjs');

/** @type {{ node: string | null, npm: string | null, npx: string | null } | null} */
let cached = null;

/**
 * Same resolver as a capability's `exec` list, so the two cannot drift on
 * PATH or symlink handling.
 * @returns {{ node: string | null, npm: string | null, npx: string | null }}
 */
function resolveMcpBins() {
  if (cached) return cached;
  const names = isWindows
    ? { node: 'node.exe', npm: 'npm.cmd', npx: 'npx.cmd' }
    : { node: 'node', npm: 'npm', npx: 'npx' };
  cached = {
    node: resolveExecName(names.node),
    npm: resolveExecName(names.npm),
    npx: resolveExecName(names.npx),
  };
  // Prefer real node next to npx when npx is a shim in the same prefix.
  if (cached.npx && !cached.node) {
    const sibling = path.join(path.dirname(cached.npx), names.node);
    if (fs.existsSync(sibling)) cached.node = sibling;
  }
  return cached;
}

/**
 * Absolute paths to allow on process-exec (and bind-read on Linux).
 * @returns {string[]}
 */
function mcpExecPaths() {
  const { node, npm, npx } = resolveMcpBins();
  return [node, npm, npx].filter(Boolean);
}

module.exports = {
  resolveMcpBins,
  mcpExecPaths,
};
