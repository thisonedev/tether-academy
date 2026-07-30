// @ts-check
'use strict';

// Public API: wrapSpawn(command, args, options, capabilities) returns
// the platform-sandboxed child invocation. Mac prepends sandbox-exec;
// Linux prepends bwrap; Windows is passthrough (AppContainer is a
// follow-up). loadDynamicCapabilities(path) merges a parent-owned
// JSON file into the static baseline — the file must live in a path
// the sandboxed child cannot write to.

const os = require('node:os');
const path = require('node:path');

const {
  CAPABILITIES,
  getCapabilities,
  expandDeep,
  defaultTemplateVars,
  loadDynamicCapabilities,
  mergeCapabilities,
} = require('./capabilities.cjs');

function defaultDynamicPath() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Tether Academy', 'sandbox-allowlist.json');
  }
  if (process.platform === 'win32') {
    return path.join(home, 'AppData', 'Roaming', 'Tether Academy', 'sandbox-allowlist.json');
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
    'Tether Academy',
    'sandbox-allowlist.json',
  );
}

function buildEnv(parentEnv, capEnv) {
  const passThrough = new Set(capEnv?.passThrough ?? []);
  const block = new Set(capEnv?.block ?? []);
  const out = {};
  for (const key of Object.keys(parentEnv ?? {})) {
    if (block.has(key)) continue;
    if (!passThrough.has(key)) continue;
    out[key] = parentEnv[key];
  }
  return out;
}

/**
 * @typedef {import('@academy/sandbox-types').WrapResult} WrapResult
 */

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ dynamicPath?: string, cwd?: string }} [options]
 * @param {string | import('@academy/sandbox-types').Capability} capabilities
 * @returns {WrapResult}
 */
function wrapSpawn(command, args, options, capabilities) {
  options = options || {};
  const base = typeof capabilities === 'string'
    ? getCapabilities(capabilities)
    : capabilities;
  if (!base) {
    throw new Error('sandbox.wrapSpawn: capabilities is required');
  }

  let cap = base;
  if (options.dynamicPath) {
    const dynamic = loadDynamicCapabilities(options.dynamicPath);
    if (dynamic) cap = mergeCapabilities(base, dynamic);
  }

  const expanded = expandDeep(cap, defaultTemplateVars());
  const env = buildEnv(process.env, expanded.env);
  const platform = process.platform;

  if (platform === 'darwin') {
    const mac = require('./sandbox-mac.cjs');
    const profile = typeof capabilities === 'string'
      ? mac.buildProfile(capabilities)
      : [
          '(version 1)',
          '(deny default)',
          ...mac._allowRules(expandDeep(cap, defaultTemplateVars())),
        ].join('\n') + '\n';
    const profilePath = mac.writeProfile(profile);
    const wrap = mac.buildWrap(profilePath, command, args);
    return {
      command: wrap.command,
      args: wrap.args,
      env,
      warnings: wrap.warnings,
      sandboxed: true,
      mode: 'mac-sandbox-exec',
      profilePath,
    };
  }

  if (platform === 'linux') {
    const linux = require('./sandbox-linux.cjs');
    const wrap = linux.buildWrap(expanded, command, args);
    return {
      command: wrap.command,
      args: wrap.args,
      env,
      warnings: wrap.warnings,
      sandboxed: !wrap.bwrapMissing,
      mode: wrap.bwrapMissing ? 'linux-passthrough' : 'linux-bwrap',
    };
  }

  if (platform === 'win32') {
    const win = require('./sandbox-windows.cjs');
    const wrap = win.buildWrap(expanded, command, args);
    return {
      command: wrap.command,
      args: wrap.args,
      env,
      warnings: wrap.warnings,
      sandboxed: false,
      mode: 'windows-passthrough',
    };
  }

  return {
    command,
    args,
    env,
    warnings: [`sandbox: unknown platform "${platform}"; child runs unsandboxed`],
    sandboxed: false,
    mode: 'passthrough',
  };
}

function listProductNames() {
  return Object.keys(CAPABILITIES);
}

module.exports = {
  wrapSpawn,
  listProductNames,
  buildEnv,
  defaultDynamicPath,
};
