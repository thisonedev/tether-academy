// @ts-check
'use strict';

// macOS per-spawn sandbox via sandbox-exec(1) (profile format: sandbox(7)).
// Writes are allowlisted by subpath; reads allow file-read* broadly (dyld
// needs it to start) then deny back, entry by entry, from what's on disk.
// Per-domain network filtering isn't available; see network.mode.
//
// sandbox-exec(1) is deprecated and is the whole boundary here; nothing
// replaces it yet. buildWrap reports a missing binary and callers refuse
// the spawn.
//
// Read-confinement gaps are tracked in the desktop README; keep that in
// sync with changes here.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const process = require('process');

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/**
 * @typedef {import('@academy/sandbox-types').MacWrapResult} MacWrap
 */

const {
  getCapabilities,
  expandDeep,
  defaultTemplateVars,
  platformFilter,
  resolveExecNames,
  confinedPaths,
} = require('./capabilities.cjs');

function sbString(s) {
  if (typeof s !== 'string') return '""';
  return JSON.stringify(s);
}

function realpathSafe(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// The floor under the generated denies: refused even when $HOME cannot be
// enumerated, plus the ones under Library, which stays readable.
const DEFAULT_READ_DENY_RELATIVE = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.config/gcloud',
  '.config/gh',
  '.netrc',
  '.kube',
  '.docker',
  'Library/Keychains',
  'Library/Cookies',
  'Library/Messages',
  'Library/Mail',
  'Library/Accounts',
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Chromium',
  'Library/Application Support/Firefox',
  'Library/Application Support/Microsoft Edge',
  'Library/Application Support/BraveSoftware',
  'Library/Application Support/1Password',
  'Library/Application Support/com.apple.TCC',
];

// Top-level home entries kept readable: `Library` holds the dyld/font caches
// the runtime starts from (named denies above cover it instead), and denying
// the CoreFoundation encoding file hangs the process silently.
const HOME_KEEP = ['Library', '.CFUserTextEncoding'];

// Credential stores outside $HOME, named individually because their parent
// dirs (/etc, /var/db) also hold files the runtime needs to start from.
const SYSTEM_READ_DENY = [
  '/etc/ssh',
  '/etc/sudoers',
  '/etc/sudoers.d',
  '/etc/pam.d',
  '/etc/openldap',
  '/etc/krb5.keytab',
  // Local account database, including password hashes.
  '/var/db/dslocal',
  '/var/db/TCC',
  '/var/root',
  // Admin-installed keychains. The trust roots the runtime needs live under
  // /System/Library/Keychains and stay readable.
  '/Library/Keychains',
  '/Library/Application Support/com.apple.TCC',
  '/opt/homebrew/etc',
  '/usr/local/etc',
];

// Sibling-account home directories; every entry but this run's own home is denied.
const HOME_PARENT = '/Users';

function isUnder(parent, child) {
  return child === parent || child.startsWith(parent + path.sep);
}

// The lesson folder is two levels down and a checked-out repo can be four.
const MAX_DENY_DEPTH = 5;

// sandbox-exec compiles the profile on every spawn and the cost climbs faster
// than the rule count (3k denies ~2s, 11k ~30s, 19k never finish), so an
// ordinary crowded directory could otherwise stop every run from starting
// with no error to explain why. Past the ceiling the rest stays readable
// and the profile warns.
const MAX_GENERATED_DENIES = 4000;

/**
 * Deny every entry of `dir` no needed path touches, descending into ones
 * that merely contain a needed path so a sibling isn't kept along with it.
 * `unresolved` collects directories TCC blocks from listing (~/Documents,
 * ~/Desktop); their contents stay readable and the caller warns about each.
 * @param {string} dir
 * @param {string[]} needed absolute paths the child must still read
 * @param {Set<string>} out
 * @param {string[]} unresolved
 * @param {number} depth
 */
function denyAround(dir, needed, out, unresolved, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    unresolved.push(dir);
    return;
  }
  for (const name of entries) {
    if (out.size >= MAX_GENERATED_DENIES) return;
    const full = path.join(dir, name);
    if (needed.some((n) => isUnder(full, n))) {
      // Keep it whole when the entry is itself needed, else descend.
      if (needed.some((n) => isUnder(n, full))) continue;
      if (depth + 1 < MAX_DENY_DEPTH) denyAround(full, needed, out, unresolved, depth + 1);
      continue;
    }
    out.add(full);
  }
}

/**
 * Every absolute path the capability still needs the child to reach, in both
 * the named and the kernel-resolved form.
 * @param {import('@academy/sandbox-types').Capability} cap
 * @param {string} command
 * @returns {string[]}
 */
function reachablePaths(cap, command) {
  const out = [];
  const entries = [
    ...(cap.fs?.read ?? []),
    ...(cap.fs?.write ?? []),
    ...(cap.fs?.readOnly ?? []),
    ...(cap.platformOverrides?.mac?.extraExecPaths ?? []),
    command,
  ];
  for (const entry of entries) {
    if (!entry) continue;
    const bare = String(entry).replace(/^(MAC|LIN|WIN|COM):/, '');
    for (const variant of new Set([bare, realpathSafe(bare)])) {
      if (variant) out.push(variant);
    }
  }
  return out;
}

/**
 * Everything the child has no business reading, generated from what's on disk
 * rather than a fixed list so a directory added later is still covered. A
 * synthetic $HOME isn't an option: it makes every model look missing, since
 * the SDK resolves its cache from it. Generated under $HOME, its parent
 * (sibling accounts), and /tmp; capped, see MAX_GENERATED_DENIES.
 * @param {import('@academy/sandbox-types').Capability} cap
 * @param {string} command
 * @returns {{ paths: Set<string>, generated: number, unresolved: string[], truncated: boolean }}
 */
function sensitiveReadDenyPaths(cap, command) {
  const home = realpathSafe(os.homedir());
  const paths = new Set();
  for (const rel of DEFAULT_READ_DENY_RELATIVE) {
    paths.add(path.join(home, rel));
  }
  for (const p of SYSTEM_READ_DENY) {
    paths.add(realpathSafe(p));
  }
  const extra = cap.platformOverrides?.mac?.denyReadPaths;
  if (Array.isArray(extra)) {
    for (const p of extra) {
      if (p) paths.add(realpathSafe(p));
    }
  }

  const reachable = reachablePaths(cap, command);
  const roots = [
    { root: home, keep: HOME_KEEP.map((name) => path.join(home, name)) },
    { root: HOME_PARENT, keep: [home] },
    { root: realpathSafe('/tmp'), keep: [] },
  ];

  const generatedPaths = new Set();
  const unresolved = [];
  for (const { root, keep } of roots) {
    const real = realpathSafe(root);
    // A path outside this root says nothing about what to keep inside it.
    const needed = [
      ...keep,
      ...reachable.filter((p) => isUnder(real, p) && p !== real),
    ];
    denyAround(real, needed, generatedPaths, unresolved);
  }
  for (const p of generatedPaths) paths.add(p);
  return {
    paths,
    generated: generatedPaths.size,
    unresolved,
    truncated: generatedPaths.size >= MAX_GENERATED_DENIES,
  };
}

function allowRules(cap, { warnings = [], command = process.execPath, runtime = 'bare' } = {}) {
  const rules = [];

  // dyld needs broad read to start; $HOME is denied below.
  rules.push('(allow file-read*)');
  const { paths: denyRead, generated, unresolved, truncated } = sensitiveReadDenyPaths(cap, command);
  for (const p of denyRead) {
    rules.push(`(deny file-read* (subpath ${sbString(p)}))`);
  }
  warnings.push(
    generated > 0
      ? `mac sandbox: file-read* with ${denyRead.size} denied paths, ${generated} of them ` +
          'generated from $HOME (a pure allowlist stops the runtime starting)'
      : 'mac sandbox: $HOME could not be enumerated; only the named denies apply',
  );
  if (truncated) {
    warnings.push(
      `mac sandbox: the deny walk stopped at ${MAX_GENERATED_DENIES} generated paths, ` +
        'so whatever it had not reached stays readable to the run',
    );
  }
  if (unresolved.length > 0) {
    warnings.push(
      `mac sandbox: could not list ${unresolved.join(', ')}, so the rest of each ` +
        'stays readable to the run; grant this app access to them to close that',
    );
  }

  for (const p of platformFilter(cap.fs?.write ?? [], 'darwin')) {
    rules.push(`(allow file-write* file-write-create (subpath ${sbString(realpathSafe(p))}))`);
  }
  // After the grants, and naming file-write-create as well as file-write*: a
  // rule for the specific operation outranks a later wildcard, so a deny that
  // lists only file-write* leaves the grant above free to create files.
  for (const p of platformFilter(cap.fs?.readOnly ?? [], 'darwin')) {
    rules.push(`(deny file-write* file-write-create (subpath ${sbString(realpathSafe(p))}))`);
  }
  // Writes may create files, never links, so a write always lands at the
  // named path rather than wherever a planted symlink points.
  rules.push('(deny file-write-create (vnode-type SYMLINK))');
  rules.push('(allow file-write* (literal "/dev/null"))');

  const { found: resolvedExec, missing: missingExec } = resolveExecNames(cap.exec ?? []);
  for (const m of missingExec) {
    warnings.push(
      `mac sandbox: exec binary "${m}" not on PATH; process-exec allowlist omits it`,
    );
  }
  const execPaths = new Set(resolvedExec);
  if (command) execPaths.add(command);
  const macOv = cap.platformOverrides?.mac ?? {};
  if (command) execPaths.add(path.dirname(command));
  execPaths.add('/bin/sh');
  // macOS may re-exec /bin/sh as bash; wrappers and npm scripts need both.
  execPaths.add('/bin/bash');
  execPaths.add('/bin/zsh');
  execPaths.add('/usr/bin/env');
  // QVAC node-rpc-client spawns bare-runtime; must be on process-exec or
  // bare-runtime's access(X_OK)/chmod path fails with EPERM under seatbelt.
  for (const p of macOv.extraExecPaths ?? []) {
    if (p) execPaths.add(p);
  }
  // Both forms: the kernel matches the resolved path, not a symlink.
  for (const p of [...execPaths]) {
    if (p) execPaths.add(realpathSafe(p));
  }
  for (const p of execPaths) {
    if (!p) continue;
    rules.push(`(allow process-exec (literal ${sbString(p)}))`);
  }
  // npm/npx install package bins under a host-chosen cache dir; shebang
  // scripts need process-exec on those paths (literals are not enough).
  for (const re of macOv.extraExecRegex ?? []) {
    if (!re) continue;
    rules.push(`(allow process-exec (regex ${sbString(re)}))`);
  }

  // Granted per run only. See capabilities.cjs for why the default matters.
  for (const [name, op] of [['microphone', 'device-microphone'], ['camera', 'device-camera']]) {
    if (!cap.device?.[name]) continue;
    rules.push(`(allow ${op})`);
    warnings.push(`mac sandbox: ${name} access granted to this run`);
  }

  // Network: sandbox-exec cannot filter by domain. mode drives the profile.
  const netMode = cap.network?.mode || 'all';
  if (netMode === 'none') {
    // No outbound IP. Local unix sockets still allowed for QVAC workers.
    warnings.push('mac sandbox: network.mode=none (no outbound IP)');
  } else if (netMode === 'localhost') {
    // Only `*` or `localhost` are valid as the host part; a literal address
    // makes sandbox-exec reject the whole profile. `localhost` here is the
    // loopback interface, covering both 127.0.0.1 and ::1.
    rules.push('(allow network-outbound (remote ip "localhost:*"))');
    warnings.push(
      'mac sandbox: network.mode=localhost (loopback only; hosts[] not used)',
    );
  } else {
    // Mode 'all' permits full outbound access. hosts[] is documentation only.
    if (Array.isArray(cap.network?.hosts) && cap.network.hosts.length > 0) {
      warnings.push(
        'mac sandbox: network.mode=all; hosts[] is documentation only ' +
          '(sandbox-exec cannot filter by domain)',
      );
    }
    rules.push('(allow network-outbound (remote ip "*:*"))');
  }
  rules.push('(allow network-outbound (remote unix-socket))');
  // QVAC bare-runtime workers talk over a local unix socket in TMPDIR.
  rules.push('(allow network-bind (local unix-socket))');
  rules.push('(allow network-inbound (local unix-socket))');
  rules.push('(allow network-outbound (local unix-socket))');
  // startQVACProvider binds a port before any model loads; loopback only.
  rules.push('(allow network-bind (local ip "localhost:*"))');

  // Node's os module and QVAC read many sysctls; a fixed name list is
  // brittle (missing entries abort Node in GetOSInformation).
  rules.push('(allow sysctl-read)');

  // bare-runtime worker child of the QVAC SDK.
  rules.push('(allow process-fork)');

  rules.push('(allow signal)');
  rules.push('(allow mach-lookup)');
  // Electron registers MachPortRendezvousServer via bootstrap_check_in and logs
  // FATAL Permission denied (1100) without this. A bare child never asks.
  if (runtime === 'node') rules.push('(allow mach-register)');
  rules.push('(allow iokit-open)');
  rules.push('(allow ipc-posix-shm)');
  rules.push('(allow ipc-sysv-shm)');
  rules.push('(allow process-info*)');

  // Last, so these outrank whatever an allowlist merged in above. Naming
  // file-write-create as well, because a grant on some parent directory names
  // it too and the specific operation would otherwise win on its own.
  for (const p of confinedPaths()) {
    const resolved = realpathSafe(p);
    rules.push(`(deny file-read* (subpath ${sbString(resolved)}))`);
    rules.push(`(deny file-write* file-write-create (subpath ${sbString(resolved)}))`);
  }

  return rules;
}

/**
 * @param {string} [capabilityName]
 * @returns {string}
 */
function buildProfile(capabilityName = 'qvac') {
  const cap = expandDeep(getCapabilities(capabilityName), defaultTemplateVars());
  return [
    '(version 1)',
    '(deny default)',
    ...allowRules(cap, { warnings: [] }),
  ].join('\n') + '\n';
}

/**
 * @param {string} profile
 * @param {{ tmpdir?: string }} [options]
 * @returns {string}
 */
function writeProfile(profile, { tmpdir = os.tmpdir() } = {}) {
  // 0600: any process running as this user is a practical reader otherwise.
  const name = `academy-sandbox-${crypto.randomBytes(6).toString('hex')}.sb`;
  const profilePath = path.join(tmpdir, name);
  fs.writeFileSync(profilePath, profile, { mode: 0o600 });
  return profilePath;
}

/**
 * @param {string} profilePath
 * @param {string} command
 * @param {string[]} [args]
 * @returns {MacWrap}
 */
function buildWrap(profilePath, command, args = []) {
  // Fail before wrapping rather than reporting sandboxed and failing later
  // as a spawn error indistinguishable from a bad command.
  if (!fs.existsSync(SANDBOX_EXEC)) {
    return {
      command,
      args,
      env: {},
      warnings: [
        `mac sandbox: ${SANDBOX_EXEC} is missing; sandbox-exec(1) is deprecated ` +
          'and this build of macOS may have dropped it',
      ],
      sandboxExecMissing: true,
    };
  }
  return {
    command: SANDBOX_EXEC,
    args: ['-f', profilePath, command, ...args],
    env: {},
    warnings: [],
    sandboxExecMissing: false,
  };
}

module.exports = {
  buildProfile,
  writeProfile,
  buildWrap,
  platformFilter,
  _allowRules: allowRules,
};
