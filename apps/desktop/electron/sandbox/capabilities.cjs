// @ts-check
'use strict';

// Capability configs for sandboxed child processes. Each entry lists
// the OS resources its runner needs; everything else is denied by the
// platform module. Add a new product by adding a key to CAPABILITIES
// and passing it to wrapSpawn() in peer.cjs.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const PREFIX = { darwin: 'MAC', linux: 'LIN', win32: 'WIN' };

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

function defaultTemplateVars(overrides = {}) {
  const appRoot = path.resolve(__dirname, '..', '..');
  const coursesDir = path.resolve(appRoot, '..', '..', 'packages', 'courses');
  const home = os.homedir();
  const tmpDir = realpathSafe(os.tmpdir());
  return {
    projectDir: overrides.projectDir || process.cwd(),
    appRoot,
    coursesDir,
    homeDir: home,
    tmpDir,
    execDir: overrides.execDir || path.dirname(process.execPath),
    execPath: process.execPath,
    userData:
      process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'Tether Academy')
        : process.platform === 'win32'
          ? path.join(home, 'AppData', 'Roaming', 'Tether Academy')
          : path.join(
              process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
              'Tether Academy',
            ),
  };
}

// `<%= name %>` and `<%= name() %>` are looked up in scope.
// Unknown templates are left as-is so the platform module can
// interpret them.
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

function resolveExecName(binName) {
  if (!binName) return null;
  if (binName.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(binName)) return binName;
  const { execFileSync } = require('node:child_process');
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('where', [binName], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      return first || null;
    }
    const out = execFileSync('command', ['-v', binName], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || null;
  } catch {
    return null;
  }
}

function resolveExecNames(execList) {
  const found = [];
  const missing = [];
  for (const entry of execList || []) {
    if (!entry) continue;
    if (entry.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(entry)) {
      found.push(entry);
      continue;
    }
    const resolved = resolveExecName(entry);
    if (resolved) found.push(resolved);
    else missing.push(entry);
  }
  return { found, missing };
}

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

// The dynamic file is trusted only because it lives in a path the
// sandboxed child cannot write to (see defaultDynamicPath in
// index.cjs). Throws on parse error so the parent fails loudly
// rather than silently running with a truncated allowlist.
function loadDynamicCapabilities(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
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
        // Public macOS system paths. /private/var/folders etc. are
        // symlinks that the kernel can't traverse under default-deny;
        // tmpDir resolves to the public /var/folders/... form.
        'MAC:/System/Library',
        'MAC:/Library/Apple/usr/lib',
        'MAC:/Library/Apple/system',
        'MAC:/opt/homebrew/lib',
        'MAC:/usr/lib',
        'MAC:/usr/local/lib',
        'LIN:/usr/lib',
        'LIN:/usr/local/lib',
        'LIN:/lib',
        'LIN:/lib64',
        'LIN:/etc/ssl',
        'LIN:/etc/alternatives',
        'LIN:/usr/share/locale',
        'LIN:/usr/share/zoneinfo',
        'LIN:/usr/share/icu',
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
        '<%= appRoot %>',
        '<%= coursesDir %>',
        '<%= homeDir %>/.qvac',
        '<%= tmpDir %>',
        '<%= userData %>',
      ],
    },
    network: {
      // Documented intent only. macOS / Linux sandbox modules
      // can't do per-domain kernel filtering; Windows needs
      // AppContainer + netsh.
      allow: [
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
    env: {
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
        'ELECTRON_RUN_AS_NODE',
        'ELECTRON_NO_ATTACH_CONSOLE',
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
      mac: {
        // The dock-hide shim peer.cjs prepends to child args. It
        // loads electron, which lives next to process.execPath.
        dockHideShim: '<%= appRoot %>/electron/dock-hide-shim.cjs',
      },
      linux: {},
      windows: {
        // Best-effort: child inherits the host token. AppContainer
        // is the real answer but needs PowerShell provisioning.
        fallback: 'restricted-token',
        appContainerName: 'tether-academy-sandbox',
      },
    },
  },
};

const PRODUCT_NAMES = Object.keys(CAPABILITIES);

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
  PRODUCT_NAMES,
  getCapabilities,
  defaultTemplateVars,
  resolveTemplate,
  expandDeep,
  platformFilter,
  resolveExecName,
  resolveExecNames,
  loadDynamicCapabilities,
  mergeCapabilities,
};
