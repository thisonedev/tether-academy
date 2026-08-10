// @ts-check
'use strict';

// Capability configs for sandboxed child processes; anything not listed
// here is denied by the platform module.

const os = require('os');
const path = require('path');
const fs = require('fs');
const process = require('process');

/**
 * @typedef {import('@academy/sandbox-types').Capability} Capability
 * @typedef {import('@academy/sandbox-types').TemplateVars} TemplateVars
 * @typedef {import('@academy/sandbox-types').DynamicCapabilityFile} DynamicCapabilityFile
 * @typedef {import('@academy/sandbox-types').ProductName} ProductName
 */

const PREFIX = { darwin: 'MAC', linux: 'LIN', win32: 'WIN' };

/**
 * @param {string[] | undefined} entries
 * @param {NodeJS.Platform} platform
 * @returns {string[]}
 */
function platformFilter(entries, platform) {
  if (!Array.isArray(entries)) return [];
  const wanted = PREFIX[platform] || null;
  const out = [];
  for (const e of entries) {
    if (typeof e !== 'string') continue;
    if (wanted && e.startsWith(`${wanted}:`)) out.push(e.slice(wanted.length + 1));
    else if (e.startsWith('COM:')) out.push(e.slice(4));
    else if (!e.includes(':')) out.push(e);
  }
  return out;
}

// macOS sandbox-exec matches the kernel-resolved path, not the
// symlink. /tmp -> /private/tmp. realpath here so the allowlist
// matches what the kernel actually sees.
function realpathSafe(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

/**
 * The app's own state directory: identity record, corestore, sandbox policy.
 * @param {string} [home]
 * @returns {string}
 */
function appStateDir(home = os.homedir()) {
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Tether Academy');
  }
  if (process.platform === 'win32') {
    return path.join(home, 'AppData', 'Roaming', 'Tether Academy');
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
    'Tether Academy',
  );
}

/**
 * Encryption keys, kept outside appStateDir so a write grant on the state
 * dir doesn't also hand over the keys.
 * @param {string} [home]
 * @returns {string}
 */
function secretsDir(home = os.homedir()) {
  return path.join(home, '.tether-academy', 'keys');
}

/**
 * Directories every platform profile must refuse, whatever an allowlist asks for.
 * @param {string} [userData] Resolved userData; falls back to appStateDir(home).
 * @param {string} [home]
 * @returns {string[]}
 */
function confinedPaths(userData, home = os.homedir()) {
  const state = userData || appStateDir(home);
  // keys dir follows --storage so an alternate state dir denies its own keys too
  const keys = userData ? path.join(userData, 'keys') : secretsDir(home);
  return [state, keys];
}

/**
 * @param {{
 *   projectDir?: string,
 *   execDir?: string,
 *   execPath?: string,
 *   runDir?: string,
 *   userData?: string,
 * }} [overrides]
 * @returns {TemplateVars}
 */
function defaultTemplateVars(overrides = {}) {
  const appRoot = path.resolve(__dirname, '..', '..');
  const workspaceRoot = path.resolve(appRoot, '..', '..');
  const coursesDir = path.resolve(workspaceRoot, 'packages', 'courses');
  const home = os.homedir();
  const tmpDir = realpathSafe(os.tmpdir());
  return {
    projectDir: overrides.projectDir || process.cwd(),
    appRoot,
    workspaceRoot,
    coursesDir,
    homeDir: home,
    tmpDir,
    runDir: overrides.runDir || path.join(tmpDir, 'academy-run'),
    lessonDir: require('../../shared/lesson-output.cjs').lessonHomeDir(home),
    execDir: overrides.execDir || (overrides.execPath ? path.dirname(overrides.execPath) : path.dirname(process.execPath)),
    execPath: overrides.execPath || process.execPath,
    userData: overrides.userData || appStateDir(home),
  };
}

// `<%= name %>` and `<%= name() %>` are looked up in scope.
// Unknown templates are left as-is so the platform module can
// interpret them.
/**
 * @param {unknown} value
 * @param {TemplateVars} scope
 * @returns {unknown}
 */
function resolveTemplate(value, scope) {
  if (typeof value !== 'string') return value;
  return value.replace(/<%=\s*([^%]+?)\s*%>/g, (m, expr) => {
    const key = expr.trim().replace(/\(\s*\)\s*$/, '');
    if (Object.prototype.hasOwnProperty.call(scope, key)) {
      const v = scope[key];
      return v == null ? '' : String(v);
    }
    return m;
  });
}

/**
 * Recursively expands <%= var %> templates through arrays and plain objects.
 * Structurally polymorphic: the return mirrors the input's shape, which TS
 * cannot express here, so both sides are intentionally untyped.
 * @param {*} value
 * @param {TemplateVars} [scope]
 * @returns {*}
 */
function expandDeep(value, scope = defaultTemplateVars()) {
  if (typeof value === 'string') return resolveTemplate(value, scope);
  if (Array.isArray(value)) return value.map((v) => expandDeep(v, scope));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandDeep(v, scope);
    return out;
  }
  return value;
}

// A GUI launch gives PATH=/usr/bin:/bin:/usr/sbin:/sbin, so `command -v`
// misses Homebrew installs. Searched after PATH, only for allowlisted names.
const FALLBACK_BIN_DIRS =
  process.platform === 'win32'
    ? []
    : ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

function isAbsoluteBin(binName) {
  return binName.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(binName);
}

function lookupOnPath(binName) {
  const { execFileSyncCompat: execFileSync } = require('./exec-file-sync.cjs');
  const [file, args] = process.platform === 'win32'
    ? ['where', [binName]]
    : ['command', ['-v', binName]];
  try {
    const out = execFileSync(file, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
  } catch {
    return null;
  }
}

function lookupInFallbackDirs(binName) {
  for (const dir of FALLBACK_BIN_DIRS) {
    const candidate = path.join(dir, binName);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

/**
 * Absolute path for a binary name, or null when it isn't installed.
 * @param {string} binName
 * @returns {string | null}
 */
function resolveExecName(binName) {
  if (!binName) return null;
  const hit = isAbsoluteBin(binName)
    ? binName
    : lookupOnPath(binName) || lookupInFallbackDirs(binName);
  if (!hit || !fs.existsSync(hit)) return null;
  return hit;
}

/**
 * Absolute paths to allowlist for a capability's `exec` names: the located
 * path and its realpath, since seatbelt matches process-exec against the
 * kernel-resolved path.
 * @param {string[] | undefined} execList
 * @returns {{ found: string[], missing: string[] }}
 */
function resolveExecNames(execList) {
  const found = [];
  const missing = [];
  const add = (p) => {
    if (p && !found.includes(p)) found.push(p);
  };
  for (const entry of execList || []) {
    if (!entry) continue;
    const resolved = resolveExecName(entry);
    if (!resolved) {
      missing.push(entry);
      continue;
    }
    add(resolved);
    add(realpathSafe(resolved));
  }
  return { found, missing };
}

/**
 * @param {*} base
 * @param {*} dynamic
 * @returns {Capability}
 */
function mergeCapabilities(base, dynamic) {
  if (!dynamic) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(dynamic)) {
    if (Array.isArray(v)) {
      out[k] = Array.from(new Set([...(out[k] || []), ...v]));
    } else if (v && typeof v === 'object') {
      out[k] = mergeCapabilities(out[k] || {}, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// 0o022: group-write or world-write; either lets a second account edit the allowlist.
const UNSAFE_ALLOWLIST_MODE = 0o022;

/**
 * Refuse an allowlist any account but the owner can edit. POSIX only; Windows
 * mode bits carry no such meaning.
 * @param {string} filePath
 */
function assertOwnerOnly(filePath) {
  if (process.platform === 'win32') return;
  const { mode } = fs.statSync(filePath);
  if ((mode & UNSAFE_ALLOWLIST_MODE) === 0) return;
  throw new Error(
    `sandbox.loadDynamicCapabilities: ${filePath} is writable beyond its owner ` +
      `(mode ${(mode & 0o777).toString(8)}); chmod 600 it or remove it`,
  );
}

// Trusted only because it lives where the sandboxed child cannot write.
// Throws on parse error so the parent fails loudly rather than running
// with a silently truncated allowlist.
/**
 * @param {string} filePath
 * @returns {DynamicCapabilityFile | null}
 */
function loadDynamicCapabilities(filePath) {
  let raw;
  try {
    assertOwnerOnly(filePath);
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err.message?.startsWith('sandbox.loadDynamicCapabilities:')) throw err;
    throw new Error(
      `sandbox.loadDynamicCapabilities: cannot read ${filePath}: ${err.message}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `sandbox.loadDynamicCapabilities: invalid JSON in ${filePath}: ${err.message}`,
    );
  }
  return parsed;
}

const CAPABILITIES = {
  qvac: {
    fs: {
      read: [
        '<%= appRoot %>',
        '<%= coursesDir %>',
        '<%= homeDir %>/.qvac',
        '<%= execDir %>',
        // System libs / dyld, needed for Node and Electron to start under constrained reads.
        'MAC:/System/Library',
        'MAC:/System/Volumes/Preboot',
        'MAC:/Library/Apple/usr/lib',
        'MAC:/Library/Apple/system',
        'MAC:/private/var/db/dyld',
        'MAC:/private/var/db/timezone',
        'MAC:/opt/homebrew/lib',
        'MAC:/usr/lib',
        'MAC:/usr/local/lib',
        'MAC:/usr/share',
        'MAC:/bin',
        'MAC:/usr/bin',
        'MAC:/dev',
        'LIN:/usr/lib',
        'LIN:/usr/local/lib',
        'LIN:/lib',
        'LIN:/lib64',
        'LIN:/etc/ssl',
        'LIN:/etc/alternatives',
        'LIN:/usr/share/locale',
        'LIN:/usr/share/zoneinfo',
        'LIN:/usr/share/icu',
        // apps/desktop/node_modules symlinks hoisted deps into the pnpm
        // workspace root's store, outside appRoot. Packaged builds ship a
        // flat node_modules and never need this.
        'LIN:<%= workspaceRoot %>/node_modules/.pnpm',
        'COM:/etc/resolv.conf',
        'COM:/etc/hosts',
        'COM:/etc/localtime',
        'COM:/etc/timezone',
        'LIN:/dev/null',
        'LIN:/dev/urandom',
        'LIN:/dev/random',
        'WIN:C:\\Windows\\System32',
        'WIN:C:\\Windows\\SystemResources',
        'WIN:C:\\Windows\\Fonts',
        'WIN:C:\\Program Files',
        'WIN:C:\\Program Files (x86)',
      ],
      write: [
        '<%= runDir %>', // not all of /tmp, which on Linux is shared with every other account
        '<%= lessonDir %>', // named lesson-output folder only, never all of Documents
        // SDK state: registry corestore, KV cache, RAG database. Weights are
        // carved back out by readOnly below.
        '<%= homeDir %>/.qvac',
      ],
      // Writable by a parent rule, then taken back per-file by wrapSpawn for
      // whatever model is already on disk, so a run can fetch a missing model
      // without being able to overwrite one the user already has.
      readOnly: [],
    },
    network: {
      // mode: 'all' full outbound (mac/linux; hosts is documentation only),
      // 'localhost' loopback only (mac), 'none' no outbound IP.
      // Denied by default, raised per run via wrapSpawn's `grants`.
      mode: 'none',
      hosts: [
        'bootstrap.hyperdht.org',
        'bootstrap1.hyperdht.org',
        'bootstrap2.hyperdht.org',
        'bootstrap3.hyperdht.org',
        '127.0.0.1',
        'localhost',
        '::1',
      ],
    },
    exec: ['ffmpeg', 'ffplay'],
    // Off by default, granted per run. A denied macOS capture returns
    // silence rather than an error, so a wrong default here is invisible.
    device: {
      microphone: false,
      camera: false,
    },
    env: {
      force: {
        NODE_NO_WARNINGS: '1',
      },
      passThrough: [
        'HOME',
        'PATH',
        'TMPDIR',
        'TMP',
        'TEMP',
        'USER',
        'USERPROFILE',
        'LOGNAME',
        'LANG',
        'LC_ALL',
        'LC_CTYPE',
        'TZ',
        'NODE_PATH',
        'NODE_OPTIONS',
        'QVAC_HYPERSWARM_SEED',
        'QVAC_LOG_LEVEL',
        'QVAC_REGISTRY_CORE_KEY',
        'QVAC_WORKER_PATH',
        'QVAC_IPC_SOCKET_PATH',
        'SNAP_USER_COMMON',
      ],
      // Stripped even if passThrough includes them. block always wins.
      block: [
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_SESSION_TOKEN',
        'GITHUB_TOKEN',
        'GH_TOKEN',
        'NPM_TOKEN',
        'CLOUDFLARE_API_TOKEN',
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
        'GOOGLE_API_KEY',
        'HUGGINGFACE_TOKEN',
      ],
    },
    platformOverrides: {
      mac: {},
      linux: {},
      windows: {
        // Best-effort: inherits the host token. AppContainer is the real
        // answer but needs PowerShell provisioning.
        fallback: 'restricted-token',
        appContainerName: 'tether-academy-sandbox',
      },
    },
  },
};

const PRODUCT_NAMES = Object.keys(CAPABILITIES);

// Grantable for a single run. wrapSpawn throws on anything else.
const DEVICE_GRANTS = ['microphone', 'camera'];
// Loopback is its own grant, narrower than 'all' but still reaching every
// service bound on this machine, so it is still asked.
const NETWORK_GRANTS = { network: 'all', 'network-loopback': 'localhost' };
const RUN_GRANTS = [...DEVICE_GRANTS, ...Object.keys(NETWORK_GRANTS)];

/**
 * The scope the platform's sandbox actually holds a run to, which can be
 * wider than requested: bwrap has no address filter, so on Linux every mode
 * above 'none' is full egress. Callers compare the two and refuse when wider.
 * @param {'all' | 'localhost' | 'none' | undefined} mode
 * @param {NodeJS.Platform} [platform]
 * @returns {'all' | 'localhost' | 'none'}
 */
function enforcedNetworkScope(mode, platform = process.platform) {
  const requested = mode || 'none';
  if (requested === 'none') return 'none';
  if (platform === 'darwin') return requested;
  return 'all';
}

/**
 * @param {string} name
 * @returns {Capability}
 */
function getCapabilities(name) {
  const cap = CAPABILITIES[name];
  if (!cap) {
    throw new Error(
      `sandbox: unknown capability "${name}". Known: ${PRODUCT_NAMES.join(', ')}`,
    );
  }
  return cap;
}

module.exports = {
  CAPABILITIES,
  DEVICE_GRANTS,
  NETWORK_GRANTS,
  RUN_GRANTS,
  PRODUCT_NAMES,
  getCapabilities,
  appStateDir,
  secretsDir,
  confinedPaths,
  enforcedNetworkScope,
  defaultTemplateVars,
  resolveTemplate,
  expandDeep,
  platformFilter,
  resolveExecName,
  resolveExecNames,
  loadDynamicCapabilities,
  mergeCapabilities,
};
