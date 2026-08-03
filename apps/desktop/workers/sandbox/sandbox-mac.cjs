// @ts-check
'use strict';

// macOS per-spawn sandbox via sandbox-exec(1). Profile format: sandbox(7).
// Writes are allowlisted by subpath. Reads cannot be pure-allowlisted, since
// dyld and the runtime need broad filesystem visibility to start, so we allow
// file-read* and then deny back, entry by entry, from what is on disk.
// Per-domain network filtering is not available; see network.mode.
//
// sandbox-exec(1) is deprecated and is the whole boundary here. Nothing
// replaces it yet: App Sandbox is entitlement-based and applies to the app
// itself, not to a per-spawn profile, and Endpoint Security is an observation
// API needing a distribution entitlement. Until one of those covers this,
// buildWrap reports a missing binary and callers refuse the spawn.
//
// What denying back leaves readable is written down in the desktop README
// under "What macOS read confinement does not cover". Those are limits of the
// mechanism, so a change here that closes one belongs in that list too.

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

// Top-level home entries no run may be denied. `Library` holds the dyld and
// font caches the runtime starts from, so it keeps the named denies above
// instead. Denying the CoreFoundation encoding file hangs the process silently.
const HOME_KEEP = ['Library', '.CFUserTextEncoding'];

// Credential stores outside $HOME. Named one by one, because the directories
// holding them also hold files the runtime starts from: /etc has resolv.conf
// and the TLS roots, /var/db has the dyld cache. Realpathed at use, since
// seatbelt matches what the kernel resolved and /etc is a symlink.
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

// Where sibling accounts live. Denying every entry but this run's own home is
// what stops a lesson reading another user's files.
const HOME_PARENT = '/Users';

function isUnder(parent, child) {
  return child === parent || child.startsWith(parent + path.sep);
}

// The lesson folder is two levels down and a checked-out repo can be four.
const MAX_DENY_DEPTH = 5;

// sandbox-exec compiles the profile on every spawn and the cost climbs faster
// than the rule count: 3k denies cost 2s, 11k cost 30s, 19k never finish. A
// directory holding thousands of entries is ordinary, so without a ceiling one
// crowded directory stops every run from starting, and a child that never
// starts produces no error to explain itself. Past the ceiling the rest of
// that directory stays readable and the profile warns.
const MAX_GENERATED_DENIES = 4000;

/**
 * Deny every entry of `dir` no needed path touches, descending into the ones
 * that merely contain one so a sibling is not kept along with it.
 *
 * `unresolved` collects directories that could not be listed — TCC blocks
 * ~/Documents and ~/Desktop unless the user grants access. Their contents stay
 * readable, and the caller warns about each.
 *
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
 * Everything the child has no business reading, generated from what is on disk
 * rather than a fixed list, so a directory added later is still covered.
 *
 * A synthetic $HOME is not an option either: it makes every model look missing,
 * since the SDK resolves its cache from it.
 *
 * The complement is generated under $HOME, under its parent so that sibling
 * accounts are covered, and under /tmp. Credential stores outside all three are
 * listed in SYSTEM_READ_DENY, since the directories around those hold files the
 * runtime starts from. What the walk generates is capped: see
 * MAX_GENERATED_DENIES for what a profile past that size costs.
 *
 * @param {import('@academy/sandbox-types').Capability} cap
 * @param {string} command
 * @returns {{ paths: Set<string>, generated: number, unresolved: string[], truncated: boolean }}
 */
function sensitiveReadDenyPaths(cap, command) {
  // Resolved, because seatbelt matches the path the kernel arrived at.
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

  // Broad read required for dyld and the runtime; $HOME denied below.
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
  // A run may create files it needs, but not links. Without this a run could
  // drop a symlink where a model is about to be downloaded and have the write
  // land wherever it points, with whatever privileges the writer holds.
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
  // Both forms. The kernel matches the resolved path, so a rule naming a
  // symlink (Homebrew bin/, .app helper stubs) never fires.
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
    // Only `*` and `localhost` are accepted as the host part. A literal address
    // makes sandbox-exec reject the whole profile, so the spawn dies instead of
    // being narrowed. `localhost` is the loopback interface here, not a name to
    // resolve, so it covers 127.0.0.1 and ::1 both.
    rules.push('(allow network-outbound (remote ip "localhost:*"))');
    warnings.push(
      'mac sandbox: network.mode=localhost (loopback only; hosts[] not used)',
    );
  } else {
    // mode 'all' — full outbound. hosts[] is documentation only.
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
  // startQVACProvider binds a port before any model loads, so the lessons that
  // call it fail with EPERM without this. Loopback only: a run may listen for
  // its own inference server, never on an address another machine can reach.
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
  // 0600: the container is per-user, so any other process running as the
  // user (including the very peer run the profile confines) is the
  // practical reader.
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
  // A wrap naming a binary that is not there would be announced as sandboxed
  // and fail later, as a spawn error indistinguishable from a bad command. See
  // the deprecation note at the top of this file.
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
