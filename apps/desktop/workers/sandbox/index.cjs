// @ts-check
'use strict';

// Public API: wrapSpawn(command, args, options, capabilities) returns
// the platform-sandboxed child invocation. Mac: sandbox-exec; Linux:
// bwrap; Windows: unavailable until AppContainer. Callers must refuse
// the spawn when sandboxed is false.

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

// The child's TMPDIR is its run directory, and QVAC opens its worker RPC socket
// there (`os.tmpdir()` + `qvac-worker-<pid>-<ts>-<rand>.sock`, no override).
// sun_path caps that path at 104 bytes, so every byte the run directory spends
// is one the SDK's name cannot have. Hence the shortest root available.
const SOCKET_PATH_MAX = 104;
const SOCKET_NAME_RESERVE = 44;
const RUN_DIR_PREFIX = 'ta-';

// Shortest first. macOS resolves /tmp to /private/tmp, but bind() measures the
// path it is handed, and the profile resolves the rule separately.
const TEMP_ROOTS = process.platform === 'win32' ? [os.tmpdir()] : ['/tmp', os.tmpdir()];

// The shells and coreutils the profile allowlists by name. Last on the PATH.
const SYSTEM_BIN_DIRS = process.platform === 'win32'
  ? []
  : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * Per-run scratch directory: the child's only writable temp, and the one that
 * has to hold a unix socket.
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
 * Every model file worth freezing, so the profile can make them immutable.
 *
 * Empty ones are skipped: the SDK streams a download to its final path, so an
 * interrupted one leaves a husk, and freezing that stops the SDK replacing it.
 *
 * A snapshot, so a model downloaded during the run stays writable until it
 * exits. The SDK's sha256 check on load covers that where the registry
 * publishes a checksum; closing it properly means the host doing the download.
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
 * Refuse a run directory that cannot hold a unix socket. Without this the
 * failure surfaces as EINVAL from inside the SDK, which says nothing about
 * which path was too long.
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
 * Default path for the dynamic capability JSON. Under the app state directory,
 * which confinedPaths() denies in every profile — a file that decides what the
 * sandbox allows cannot be one the sandboxed child can write.
 * @returns {string}
 */
function defaultDynamicPath() {
  return path.join(appStateDir(), 'policy', ALLOWLIST_FILE);
}

/**
 * Where the allowlist used to live, back when the whole state directory was
 * child-writable. Never read: a file at this path may be the child's own work.
 * @returns {string}
 */
function legacyDynamicPath() {
  return path.join(appStateDir(), ALLOWLIST_FILE);
}

/** Where the child's npm cache lives. Read-only under _npx; see wrapSpawn. */
function npmCacheDir() {
  return path.join(defaultTemplateVars().tmpDir, 'academy-npm-cache');
}

/**
 * MCP servers the shipped course allowlist permits.
 * @returns {string[]}
 */
function allowedMcpPackages(options = {}) {
  const { merged } = loadAllowlists(options);
  const list = merged?.mcpPackages;
  return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
}

/** Course-shipped allowlist + optional user file (user wins on conflicts). */
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
 * Drop read and write grants that reach the app's own state or keys, whatever
 * the merged allowlist asked for. macOS also emits explicit denies. Linux has
 * no deny form, only binds, so dropping the grant is the whole enforcement
 * there; Windows refuses peer-exec outright.
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

/** Turn bare command names in cap.exec into absolute paths for process-exec. */
function resolveCapExecPaths(cap) {
  const { found } = resolveExecNames(cap.exec ?? []);
  return found;
}

/**
 * Refuse a Node child that could reach Electron's own APIs.
 *
 * The Node runtime is the app's own Electron binary. Without
 * ELECTRON_RUN_AS_NODE it boots as Electron, and `require('electron')` hands
 * the run `safeStorage`, which decrypts the identity record. No sandbox rule
 * covers that: it is a library call inside a process the profile already
 * allows. So the guarantee has to be that the child never starts without it.
 *
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
  // Capability-forced vars win (e.g. the TMPDIR pointing at this run's scratch).
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
  } catch {
    // use as-is
  }
  // Escape for Scheme/sandbox regex; allow any file under the directory.
  const escaped = String(real).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${escaped}/.*`;
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
        readExtra.push(path.dirname(variant));
      } catch {
        // ignore
      }
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
 * Add the resolved bare runtime binary to the capability's exec allowlist.
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
 * Wrap a child spawn with a platform-specific sandbox.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {WrapOptions} options
 * @param {ProductName | Capability} capabilities
 * @returns {WrapResult}
 * @example
 *   const r = wrapSpawn(process.execPath, ['-e', '...'], {}, 'qvac');
 *   spawn(r.command, r.args, { env: { ...process.env, ...r.env } });
 */
/**
 * Wrap a child spawn with a platform-specific sandbox.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {WrapOptions} options
 * @param {ProductName | Capability} capabilities
 * @returns {WrapResult}
 * @example
 *   const r = wrapSpawn(process.execPath, ['-e', '...'], {}, 'qvac');
 *   spawn(r.command, r.args, { env: { ...process.env, ...r.env } });
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
  // Always merge course allowlist + user allowlist (user overrides).
  const { merged: allowlist, warnings: allowlistWarnings } = loadAllowlists(options);
  if (allowlist) cap = mergeCapabilities(cap, allowlist);
  warnings.push(...allowlistWarnings);

  // Per-run grants. Deliberately not readable from an allowlist file; the caller
  // names what a human approved. A network grant replaces the capability's mode
  // outright, so a file cannot leave more open than was asked for.
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

  // The caller owns the run directory when it passes one, so it can put the
  // snippet there and delete the lot afterwards.
  const runDir = options.runDir || makeRunDir();
  assertSocketRoom(runDir);
  const templateVars = defaultTemplateVars({
    execPath: command,
    runDir,
    // The host resolved userData from app.getPath('userData'); that is the
    // real state directory, not the home-default that the capability would
    // otherwise name. The profile denies this path; without it, the
    // capability's default could disagree with where the data lives.
    userData: options.userData,
  });
  const cacheDir = npmCacheDir();
  // Where npx extracts package bins: the one part of the cache the child may
  // execute from, and so the one part it may not write.
  const npxDir = path.join(cacheDir, '_npx');
  let bareBin = null;
  let toolWrapperDir = null;

  // cap.exec is final after the allowlist merge. Resolved here so the child's
  // PATH can carry these directories; a process-exec rule is useless if
  // `spawn('ffmpeg')` cannot find the binary.
  const resolvedExec = resolveCapExecPaths(cap);
  const execDirs = [];
  for (const p of resolvedExec) {
    const dir = path.dirname(p);
    if (dir && !execDirs.includes(dir)) execDirs.push(dir);
  }
  // Only directories the profile allowlists, never the parent's PATH: execvp
  // walks PATH in order and gives up the moment an entry returns EPERM, so one
  // unreadable directory ahead of the right one breaks `spawn('ffmpeg')`.
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
      } catch {
        // best-effort; npm creates it too
      }
      // npm picks the bin paths, so exec has to be a regex over a tree, which
      // only holds while the child cannot write it. npm still needs the rest of
      // the cache (it opens _cacache/tmp even when fully cached), hence the split.
      const execRegex = [
        pathToExecRegex(wrappers.dir),
        pathToExecRegex(npxDir),
      ].filter(Boolean);
      cap = appendExtraExec(cap, wrappers.paths, execRegex);
      cap = {
        ...cap,
        fs: {
          ...(cap.fs ?? {}),
          read: [...(cap.fs?.read ?? []), wrappers.dir, cacheDir],
          write: [...(cap.fs?.write ?? []), cacheDir],
          readOnly: [...(cap.fs?.readOnly ?? []), npxDir],
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
  // Freeze the models already on disk. After expansion, since these are real
  // paths that change between runs.
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
  // os.tmpdir() reads these, so the child's idea of "temp" is the one directory
  // it can write.
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
  // The scope the child ends up with, for callers that record it.
  const networkScope = enforcedNetworkScope(expanded.network?.mode, platform);

  if (platform === 'darwin') {
    const mac = require('./sandbox-mac.cjs');
    const profileBody = [
      '(version 1)',
      '(deny default)',
      ...mac._allowRules(expanded, { warnings, command, runtime }),
    ].join('\n') + '\n';
    // Run dir is 0700 and torn down by finishRun; this keeps the profile
    // off the shared tmp container and ties its lifetime to its consumer.
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
    // A bwrap that cannot open a namespace confines nothing. Reported apart
    // from a missing bwrap, because the user fixes each one differently.
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
