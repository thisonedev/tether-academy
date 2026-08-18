// @ts-check
'use strict';

// Public API: wrapSpawn(...) returns the platform-sandboxed invocation; callers must refuse the spawn when sandboxed is false.

const fs = require('fs');
const os = require('os');
const path = require('path');
const process = require('process');

const {
  CAPABILITIES,
  DEVICE_GRANTS,
  NETWORK_GRANTS,
  RUN_GRANTS,
  getCapabilities,
  expandDeep,
  defaultTemplateVars,
  loadDynamicCapabilities,
  mergeCapabilities,
  resolveExecNames,
  appStateDir,
  confinedPaths,
  enforcedNetworkScope,
} = require('./capabilities.cjs');

/**
 * @typedef {import('@academy/sandbox-types').Capability} Capability
 * @typedef {import('@academy/sandbox-types').WrapOptions} WrapOptions
 * @typedef {import('@academy/sandbox-types').WrapResult} WrapResult
 * @typedef {import('@academy/sandbox-types').ProductName} ProductName
 */

const COURSE_ALLOWLIST_PATH = path.join(__dirname, 'course-allowlist.json');

const ALLOWLIST_FILE = 'sandbox-allowlist.json';

// QVAC's worker RPC socket lives under the child's TMPDIR; sun_path caps
// that path at 104 bytes, so the run dir must leave room for the name.
const SOCKET_PATH_MAX = 104;
const SOCKET_NAME_RESERVE = 44;
const RUN_DIR_PREFIX = 'ta-';

// Shortest first; macOS resolves /tmp to /private/tmp but bind() measures the path as given.
const TEMP_ROOTS = process.platform === 'win32' ? [os.tmpdir()] : ['/tmp', os.tmpdir()];

const SYSTEM_BIN_DIRS = process.platform === 'win32'
  ? []
  : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * Per-run scratch directory: the child's only writable temp, holding a unix socket.
 * @returns {string}
 */
function makeRunDir() {
  let lastErr = null;
  for (const root of TEMP_ROOTS) {
    try {
      return fs.mkdtempSync(path.join(root, RUN_DIR_PREFIX));
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`sandbox: no writable temp root (${lastErr?.message ?? 'unknown'})`);
}

/**
 * Model files to freeze read-only, skipping empty interrupted-download files
 * so the SDK can still replace them; a snapshot taken before expansion.
 * @returns {string[]}
 */
function cachedModelFiles() {
  try {
    const { scan, modelsRoot } = require('../../shared/model-integrity.cjs');
    const root = modelsRoot();
    return [...scan(root).entries()]
      .filter(([, stat]) => stat.sizeBytes > 0)
      .map(([rel]) => path.join(root, rel));
  } catch {
    return [];
  }
}

/**
 * Refuse a run directory too short for a unix socket, for a clear error here rather than an opaque EINVAL from the SDK.
 * @param {string} runDir
 */
function assertSocketRoom(runDir) {
  if (process.platform === 'win32') return; // named pipes, no sun_path
  const room = SOCKET_PATH_MAX - Buffer.byteLength(runDir) - 1;
  if (room >= SOCKET_NAME_RESERVE) return;
  throw new Error(
    `sandbox.wrapSpawn: run directory leaves ${room} bytes for a unix socket, ` +
      `need ${SOCKET_NAME_RESERVE}. QVAC opens its worker socket in the child's ` +
      `TMPDIR and sun_path caps the path at ${SOCKET_PATH_MAX} bytes: ${runDir}`,
  );
}

/**
 * Default path for the dynamic capability JSON, under the state directory
 * that confinedPaths() denies. The child must never write its own allowlist.
 * @returns {string}
 */
function defaultDynamicPath() {
  return path.join(appStateDir(), 'policy', ALLOWLIST_FILE);
}

/**
 * Legacy allowlist path from before the state dir was locked down; never read.
 * @returns {string}
 */
function legacyDynamicPath() {
  return path.join(appStateDir(), ALLOWLIST_FILE);
}

function npmCacheDir() {
  return path.join(defaultTemplateVars().tmpDir, 'academy-npm-cache');
}

/**
 * @returns {string[]}
 */
function allowedMcpPackages(options = {}) {
  const { merged } = loadAllowlists(options);
  const list = merged?.mcpPackages;
  return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
}

function loadAllowlists(options = {}) {
  let merged = null;
  const warnings = [];
  const course = loadDynamicCapabilities(COURSE_ALLOWLIST_PATH);
  if (course) merged = mergeCapabilities({}, stripAllowlistMeta(course));

  const userPath = options.dynamicPath || defaultDynamicPath();
  const user = loadDynamicCapabilities(userPath);
  if (user) {
    merged = mergeCapabilities(merged || {}, stripAllowlistMeta(user));
  }

  if (!options.dynamicPath && fs.existsSync(legacyDynamicPath())) {
    warnings.push(
      `sandbox: ignoring the allowlist at ${legacyDynamicPath()}; it predates ` +
        `write confinement and may have been written by lesson code. Move the ` +
        `entries you want into ${userPath} by hand.`,
    );
  }
  return { merged, warnings, coursePath: COURSE_ALLOWLIST_PATH, userPath };
}

/**
 * Drop read/write grants that reach the app's own state or keys (macOS also emits explicit denies; Linux has no deny form, so dropping here is it).
 * @param {Capability} cap
 * @param {string[]} [warnings]
 * @returns {Capability}
 */
function stripConfinedPaths(cap, warnings = []) {
  const confined = confinedPaths().map(realpathSafe);
  const reaches = (entry) => {
    const p = realpathSafe(String(entry).replace(/^(MAC|LIN|WIN|COM):/, ''));
    return confined.some((c) => p === c || p.startsWith(c + path.sep));
  };
  const filter = (list, kind) =>
    (list ?? []).filter((entry) => {
      if (!reaches(entry)) return true;
      warnings.push(`sandbox: dropped ${kind} grant on ${entry} (app state is never reachable from a lesson)`);
      return false;
    });
  return {
    ...cap,
    fs: {
      ...(cap.fs ?? {}),
      read: filter(cap.fs?.read, 'read'),
      write: filter(cap.fs?.write, 'write'),
    },
  };
}

function stripAllowlistMeta(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  delete out.$comment;
  delete out.comment;
  return out;
}

function realpathSafe(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function resolveCapExecPaths(cap) {
  const { found } = resolveExecNames(cap.exec ?? []);
  return found;
}

/**
 * Refuse a Node child that could reach Electron's own APIs.
 * @param {'bare' | 'node'} runtime
 * @param {Record<string, string>} env
 */
function assertRunAsNode(runtime, env) {
  if (runtime !== 'node') return;
  if (env.ELECTRON_RUN_AS_NODE === '1') return;
  throw new Error(
    'sandbox.wrapSpawn: a node-runtime child must set ELECTRON_RUN_AS_NODE=1. ' +
      'Without it the child boots as Electron and require("electron") reaches ' +
      'safeStorage, which decrypts the identity record.',
  );
}

/**
 * Filtered env: only passThrough names pass; block always wins.
 * @param {NodeJS.ProcessEnv} parentEnv
 * @param {Capability['env']} capEnv
 * @returns {Record<string, string>}
 */
function buildEnv(parentEnv, capEnv) {
  const passThrough = new Set(capEnv?.passThrough ?? []);
  const block = new Set(capEnv?.block ?? []);
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of Object.keys(parentEnv ?? {})) {
    if (block.has(key)) continue;
    if (!passThrough.has(key)) continue;
    out[key] = parentEnv[key];
  }
  // Capability-forced vars always win over passThrough.
  const force = capEnv?.force;
  if (force && typeof force === 'object') {
    for (const [key, value] of Object.entries(force)) {
      if (block.has(key)) continue;
      if (value == null) continue;
      out[key] = String(value);
    }
  }
  return out;
}

function pathToExecRegex(dir) {
  if (!dir) return null;
  let real = dir;
  try {
    real = fs.realpathSync(dir);
  } catch {}
  const escaped = String(real).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${escaped}/.*`;
}

// node/npm/npx style installs resolve to a symlink into a whole package
// tree (e.g. .../lib/node_modules/npm/bin/npx-cli.js), which requires
// sibling files across that package; binding just the file's own directory
// leaves those requires unresolved. Walk up to the package root instead.
function packageRootFor(p) {
  const parts = p.split(path.sep);
  const idx = parts.lastIndexOf('node_modules');
  if (idx === -1 || idx + 1 >= parts.length) return null;
  const nameParts = parts[idx + 1].startsWith('@') ? 2 : 1;
  if (idx + nameParts >= parts.length) return null;
  return parts.slice(0, idx + 1 + nameParts).join(path.sep);
}

function appendExtraExec(cap, paths, regexes = []) {
  const list = (paths ?? []).filter(Boolean);
  const reList = (regexes ?? []).filter(Boolean);
  if (list.length === 0 && reList.length === 0) return cap;
  const readExtra = [];
  for (const p of list) {
    // Linux binds by path, so a symlink alone leaves a dangling link.
    for (const variant of new Set([p, realpathSafe(p)])) {
      readExtra.push(variant);
      try {
        readExtra.push(packageRootFor(variant) ?? path.dirname(variant));
      } catch {}
    }
  }
  return {
    ...cap,
    fs: {
      ...(cap.fs ?? {}),
      read: [...(cap.fs?.read ?? []), ...readExtra],
    },
    platformOverrides: {
      ...(cap.platformOverrides ?? {}),
      mac: {
        ...(cap.platformOverrides?.mac ?? {}),
        extraExecPaths: [
          ...((cap.platformOverrides?.mac?.extraExecPaths) ?? []),
          ...list,
        ],
        extraExecRegex: [
          ...((cap.platformOverrides?.mac?.extraExecRegex) ?? []),
          ...reList,
        ],
      },
    },
  };
}

/**
 * @param {Capability} cap
 * @param {{ bareRuntimeBinPath?: string | null }} [options]
 * @returns {{ cap: Capability, bareBin: string | null }}
 */
function injectBareExec(cap, options = {}) {
  const { ensureBareExecutable } = require('../../shared/bare-bin.cjs');
  const bareBin = ensureBareExecutable(options.bareRuntimeBinPath ?? null);
  if (!bareBin) return { cap, bareBin: null };
  return { cap: appendExtraExec(cap, [bareBin]), bareBin };
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {WrapOptions} options
 * @param {ProductName | Capability} capabilities
 * @returns {WrapResult}
 */
function wrapSpawn(command, args, options, capabilities) {
  options = options || {};
  // Which interpreter `command` is. Only 'node' needs the Electron guards.
  const runtime = options.runtime === 'node' ? 'node' : 'bare';
  const base = typeof capabilities === 'string'
    ? getCapabilities(capabilities)
    : capabilities;
  if (!base) {
    throw new Error('sandbox.wrapSpawn: capabilities is required');
  }

  const warnings = [];

  let cap = base;
  const { merged: allowlist, warnings: allowlistWarnings } = loadAllowlists(options);
  if (allowlist) cap = mergeCapabilities(cap, allowlist);
  warnings.push(...allowlistWarnings);

  // Per-run grants: not readable from an allowlist file (the caller names what a human approved); a network grant replaces the mode outright.
  const grants = Array.isArray(options.grants) ? options.grants : [];
  if (grants.length > 0) {
    const device = { ...(cap.device ?? {}) };
    let netMode = null;
    for (const name of grants) {
      if (!RUN_GRANTS.includes(name)) {
        throw new Error(`sandbox.wrapSpawn: unknown run grant "${name}"`);
      }
      if (DEVICE_GRANTS.includes(name)) device[name] = true;
      else netMode = NETWORK_GRANTS[name];
    }
    cap = { ...cap, device };
    if (netMode) cap = { ...cap, network: { ...(cap.network ?? {}), mode: netMode } };
  }

  const productName = typeof capabilities === 'string' ? capabilities : null;
  const wantQvac =
    productName === 'qvac' ||
    options.includeBare === true ||
    cap === CAPABILITIES.qvac;

  // The caller owns the run directory when it passes one.
  const runDir = options.runDir || makeRunDir();
  assertSocketRoom(runDir);
  const templateVars = defaultTemplateVars({
    execPath: command,
    runDir,
    // Host-resolved userData (app.getPath('userData')) is the real state dir.
    userData: options.userData,
  });
  const cacheDir = npmCacheDir();
  // Where npx extracts package bins: the one part of the cache the child may execute from, so the one part it may not write.
  const npxDir = path.join(cacheDir, '_npx');
  let bareBin = null;
  let toolWrapperDir = null;

  const resolvedExec = resolveCapExecPaths(cap);
  const execDirs = [];
  for (const p of resolvedExec) {
    const dir = path.dirname(p);
    if (dir && !execDirs.includes(dir)) execDirs.push(dir);
  }
  // Never the parent's PATH: execvp stops at the first EPERM, so one unreadable dir ahead breaks spawn('ffmpeg').
  const childPath = (prefix) =>
    [prefix, ...execDirs, ...SYSTEM_BIN_DIRS].filter(Boolean).join(path.delimiter);

  if (wantQvac) {
    const bareInjected = injectBareExec(cap, options);
    cap = bareInjected.cap;
    bareBin = bareInjected.bareBin;
    if (!bareBin) {
      warnings.push(
        'sandbox: bare-runtime binary not found; QVAC worker spawn may fail under the kernel sandbox',
      );
    }

    // PATH shims so MCP's stripped env still gets a safe npm cache (not ~/.npm).
    try {
      const { createToolWrappers } = require('./tool-wrappers.cjs');
      const wrappers = createToolWrappers({
        cacheDir,
        tmpDir: templateVars.tmpDir,
      });
      toolWrapperDir = wrappers.dir;
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
      } catch {}
      // npm picks the bin paths, so exec has to be a regex over a tree that
      // holds only while the child can't write it; npm still opens _cacache/tmp even when cached.
      const execRegex = [
        pathToExecRegex(wrappers.dir),
        pathToExecRegex(npxDir),
      ].filter(Boolean);
      cap = appendExtraExec(cap, wrappers.paths, execRegex);
      // npx's lock release rmdir's concurrency.lock, which needs write on its
      // *parent*; a self-bind (src === dest) makes the real hash dir
      // writable in place, without swapping out its already-warmed contents.
      const { hashDirsFor } = require('./mcp-warm.cjs');
      const lockOverrides = hashDirsFor(cacheDir, Array.isArray(options.npxPackages) ? options.npxPackages : [])
        .map((hash) => path.join(npxDir, hash))
        .map((dir) => ({ src: dir, dest: dir }));
      cap = {
        ...cap,
        fs: {
          ...(cap.fs ?? {}),
          read: [...(cap.fs?.read ?? []), wrappers.dir, cacheDir],
          write: [...(cap.fs?.write ?? []), cacheDir],
          readOnly: [...(cap.fs?.readOnly ?? []), npxDir],
          writeOverride: [...(cap.fs?.writeOverride ?? []), ...lockOverrides],
        },
      };
      cap = {
        ...cap,
        env: {
          ...(cap.env ?? {}),
          force: {
            ...(cap.env?.force ?? {}),
            ...wrappers.env,
            PATH: childPath(toolWrapperDir),
          },
        },
      };
      if (wrappers.paths.length === 0) {
        warnings.push(
          'sandbox: node/npx not found on PATH; course samples that spawn CLI tools may fail',
        );
      }
    } catch (err) {
      warnings.push(`sandbox: tool wrappers failed: ${err?.message ?? err}`);
    }
  }

  if (resolvedExec.length > 0) {
    cap = appendExtraExec(cap, resolvedExec);
  }

  const expanded = stripConfinedPaths(expandDeep(cap, templateVars), warnings);
  // Freeze the models already on disk. After expansion, since these are real paths that change between runs.
  expanded.fs = {
    ...(expanded.fs ?? {}),
    readOnly: [...(expanded.fs?.readOnly ?? []), ...cachedModelFiles()],
  };
  if (wantQvac && expanded.env) {
    expanded.env.force = {
      ...(expanded.env.force ?? {}),
      npm_config_cache: cacheDir,
      NPM_CONFIG_CACHE: cacheDir,
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
    };
    if (toolWrapperDir) {
      expanded.env.force.PATH = childPath(toolWrapperDir);
    }
  }
  // os.tmpdir() reads these, so the child's idea of "temp" is the one directory it can write.
  if (expanded.env) {
    expanded.env.force = {
      ...(expanded.env.force ?? {}),
      TMPDIR: runDir,
      TMP: runDir,
      TEMP: runDir,
    };
    if (runtime === 'node') {
      expanded.env.force.ELECTRON_RUN_AS_NODE = '1';
      expanded.env.force.ELECTRON_NO_ATTACH_CONSOLE = '1';
    }
  }
  const env = buildEnv(process.env, expanded.env);
  assertRunAsNode(runtime, env);
  const platform = process.platform;
  const networkScope = enforcedNetworkScope(expanded.network?.mode, platform);

  if (platform === 'darwin') {
    const mac = require('./sandbox-mac.cjs');
    const profileBody = [
      '(version 1)',
      '(deny default)',
      ...mac._allowRules(expanded, { warnings, command, runtime }),
    ].join('\n') + '\n';
    // Run dir is 0700 and torn down by finishRun, so the profile's lifetime ties to its consumer.
    const profilePath = mac.writeProfile(profileBody, { tmpdir: runDir });
    const wrap = mac.buildWrap(profilePath, command, args);
    return {
      command: wrap.command,
      args: wrap.args,
      env,
      warnings: [...warnings, ...(wrap.warnings ?? [])],
      sandboxed: !wrap.sandboxExecMissing,
      mode: wrap.sandboxExecMissing ? 'mac-no-sandbox-exec' : 'mac-sandbox-exec',
      networkScope,
      profilePath,
      bareBin,
      toolWrapperDir,
      runDir,
    };
  }

  if (platform === 'linux') {
    const linux = require('./sandbox-linux.cjs');
    const wrap = linux.buildWrap(expanded, command, args);
    // A bwrap that cannot open a namespace confines nothing; reported apart from a missing bwrap since each is fixed differently.
    const linuxMode = wrap.bwrapMissing
      ? 'linux-passthrough'
      : wrap.namespacesUnavailable
        ? 'linux-no-userns'
        : wrap.seccompUnavailable
          ? 'linux-no-seccomp'
          : 'linux-bwrap';
    return {
      command: wrap.command,
      args: wrap.args,
      env,
      warnings: [...warnings, ...(wrap.warnings ?? [])],
      sandboxed: linuxMode === 'linux-bwrap',
      mode: linuxMode,
      networkScope,
      seccompFilter: wrap.seccompFilter,
      bareBin,
      toolWrapperDir,
      runDir,
    };
  }

  if (platform === 'win32') {
    const win = require('./sandbox-windows.cjs');
    const wrap = win.buildWrap(expanded, command, args);
    return {
      command: wrap.command,
      args: wrap.args,
      env,
      warnings: [...warnings, ...(wrap.warnings ?? [])],
      sandboxed: false,
      mode: wrap.mode || 'windows-unavailable',
      networkScope,
      bareBin,
      toolWrapperDir,
      runDir,
    };
  }

  return {
    command,
    args,
    env,
    warnings: [
      ...warnings,
      `sandbox: unknown platform "${platform}"; no confinement available`,
    ],
    sandboxed: false,
    mode: 'unavailable',
    networkScope,
    bareBin,
    toolWrapperDir,
    runDir,
  };
}

module.exports = {
  wrapSpawn,
  assertRunAsNode,
  npmCacheDir,
  allowedMcpPackages,
  warmPackages: (cacheDir, packages) => require('./mcp-warm.cjs').warmPackages(cacheDir, packages),
  buildEnv,
  makeRunDir,
  assertSocketRoom,
  SOCKET_PATH_MAX,
  SOCKET_NAME_RESERVE,
  enforcedNetworkScope,
  openSeccompFd: (filter) => require('./sandbox-linux.cjs').openSeccompFd(filter),
  defaultDynamicPath,
  legacyDynamicPath,
  loadAllowlists,
  stripConfinedPaths,
  COURSE_ALLOWLIST_PATH,
  injectBareExec,
};
