// @ts-check
'use strict';

// Pre-installs the MCP servers course lessons spawn.
//
// `npx -y <pkg>` writes the package into the exec cache and then runs it, and
// the profile keeps that subtree read-only so a run cannot execute what it just
// wrote. Installing from here keeps the split: the host writes, the child reads.
//
// The list comes from course-allowlist.json, never from the code being run.

const fs = require('fs');
const path = require('path');
const process = require('process');

const { resolveMcpBins } = require('./mcp-bins.cjs');

// A cold install pulls a whole dependency tree.
const WARM_TIMEOUT_MS = 4 * 60_000;

// Skips the install, which still costs seconds when the package is present.
/** npx unpacks into `_npx/<hash>/node_modules/<pkg>`; the hash is npm's own. */
function isWarm(cacheDir, pkg) {
  const root = path.join(cacheDir, '_npx');
  let hashes;
  try {
    hashes = fs.readdirSync(root);
  } catch {
    return false;
  }
  return hashes.some((hash) => {
    try {
      return fs.statSync(path.join(root, hash, 'node_modules', pkg)).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Install `pkg` into the child's npm cache, from this process rather than the
 * sandbox. `--package … -- node -e 0` because an MCP server given no arguments
 * starts serving on stdio and never exits.
 * @param {string} cacheDir
 * @param {string} pkg
 * @returns {{ ok: boolean, error?: string }}
 */
function warmPackage(cacheDir, pkg) {
  if (isWarm(cacheDir, pkg)) return { ok: true };
  const { npx } = resolveMcpBins();
  if (!npx) return { ok: false, error: 'npx is not installed on this device' };

  const { execFileSyncCompat: execFileSync } = require('./exec-file-sync.cjs');
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    execFileSync(npx, ['--yes', '--package', pkg, '--', 'node', '-e', '0'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: WARM_TIMEOUT_MS,
      env: {
        ...process.env,
        npm_config_cache: cacheDir,
        NPM_CONFIG_CACHE: cacheDir,
        npm_config_update_notifier: 'false',
        npm_config_fund: 'false',
      },
    });
  } catch (err) {
    return { ok: false, error: err?.message ? String(err.message).slice(0, 200) : 'install failed' };
  }
  return isWarm(cacheDir, pkg)
    ? { ok: true }
    : { ok: false, error: `${pkg} did not appear in the cache after install` };
}

/**
 * @param {string} cacheDir
 * @param {string[]} packages already checked against the shipped allowlist
 * @returns {{ ok: boolean, failed: Array<{ pkg: string, error: string }> }}
 */
function warmPackages(cacheDir, packages) {
  const failed = [];
  for (const pkg of packages) {
    const result = warmPackage(cacheDir, pkg);
    if (!result.ok) failed.push({ pkg, error: result.error ?? 'unknown' });
  }
  return { ok: failed.length === 0, failed };
}

module.exports = { isWarm, warmPackage, warmPackages, WARM_TIMEOUT_MS };
