// @ts-check
'use strict';

// Pre-installs the MCP servers course lessons spawn, from the host; the package list comes from course-allowlist.json, never the running code.

const fs = require('fs');
const path = require('path');
const process = require('process');

const { resolveMcpBins } = require('./mcp-bins.cjs');

// A cold install pulls a whole dependency tree.
const WARM_TIMEOUT_MS = 4 * 60_000;

/** npx unpacks into `_npx/<hash>/node_modules/<pkg>`; the hash is npm's own. */
function isWarm(cacheDir, pkg) {
  return hashDirsFor(cacheDir, [pkg]).length > 0;
}

/**
 * Hash directory names under `_npx` that hold any of `packages`. npx locks
 * per hash dir (a `concurrency.lock` it mkdir's even for an already-cached
 * package); the sandbox needs these specific names to grant that one write.
 * @param {string} cacheDir
 * @param {string[]} packages
 * @returns {string[]}
 */
function hashDirsFor(cacheDir, packages) {
  const root = path.join(cacheDir, '_npx');
  let hashes;
  try {
    hashes = fs.readdirSync(root);
  } catch {
    return [];
  }
  return hashes.filter((hash) =>
    packages.some((pkg) => {
      try {
        return fs.statSync(path.join(root, hash, 'node_modules', pkg)).isDirectory();
      } catch {
        return false;
      }
    }),
  );
}

/**
 * Installs `pkg` into the child's npm cache from this process. The package-only
 * invocation avoids leaving an MCP server on stdio forever.
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

module.exports = { isWarm, hashDirsFor, warmPackage, warmPackages, WARM_TIMEOUT_MS };
