// @ts-check
'use strict';

// Linux per-spawn sandbox via bubblewrap (bwrap). Creates a new user
// + mount + PID namespace; per-path enforcement works because the
// mount namespace only sees what we bind in. Needs unprivileged user
// namespaces, and buildWrap probes for one before it promises any. If
// bwrap is missing or the namespace is refused, buildWrap says so and
// callers refuse the spawn.
//
// Per-syscall rules come from seccomp-filter.cjs and reach bwrap as a
// descriptor, which is why buildWrap returns a filter for the spawning
// side to open. Which binaries the child may execve is still not
// restricted; that needs argument inspection this filter does not do.

const { execFileSyncCompat: execFileSync } = require('./exec-file-sync.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const process = require('process');

const seccomp = require('./seccomp-filter.cjs');

// Where the child sees the compiled filter. The spawning side puts it at this
// slot; index 0-2 are the child's stdio.
const SECCOMP_FD = 3;

/**
 * @typedef {import('@academy/sandbox-types').Capability} Capability
 * @typedef {import('@academy/sandbox-types').LinuxWrap} LinuxWrap
 */

const {
  getCapabilities,
  expandDeep,
  defaultTemplateVars,
  platformFilter,
  resolveExecNames,
} = require('./capabilities.cjs');

const DEFAULT_BWRAP = '/usr/bin/bwrap';

// A namespace either comes up in milliseconds or the kernel has refused it.
const PROBE_TIMEOUT_MS = 5_000;

// One probe per binary path, since the answer is a kernel setting.
const probeCache = new Map();

/**
 * The filter as a file descriptor, the only form bwrap takes it in. Written to
 * a temp file that is unlinked before it is used, so no path is left for
 * anything to rewrite between the write and bwrap's read.
 * @param {Buffer} filter
 * @returns {number}
 */
function openSeccompFd(filter) {
  const file = path.join(
    os.tmpdir(),
    `ta-seccomp-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  fs.writeFileSync(file, filter, { mode: 0o600 });
  const fd = fs.openSync(file, 'r');
  try {
    fs.unlinkSync(file);
  } catch {
    // the descriptor is already open; the name is all that leaks
  }
  return fd;
}

/**
 * Spawn bwrap once and see whether the namespace comes up with the filter on.
 * Distributions can ship bubblewrap with `kernel.unprivileged_userns_clone`
 * off, and the binary then exists while failing at the one step the whole
 * Linux boundary rests on. Trusting the file to be there reports confinement
 * the child never gets. The filter rides along because a bwrap too old for
 * `--seccomp` fails the same way and wants the same refusal.
 * @param {string} bwrapPath
 * @param {Buffer} filter
 * @returns {{ ok: boolean, error: string | null }}
 */
function probeNamespaces(bwrapPath, filter) {
  const cached = probeCache.get(bwrapPath);
  if (cached) return cached;
  let result;
  let fd = null;
  try {
    fd = openSeccompFd(filter);
    execFileSync(
      bwrapPath,
      ['--unshare-all', '--ro-bind', '/', '/', '--seccomp', String(SECCOMP_FD), '--', 'true'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'pipe', fd],
        timeout: PROBE_TIMEOUT_MS,
      },
    );
    result = { ok: true, error: null };
  } catch (err) {
    const detail = (err?.stderr || err?.message || '').toString().trim();
    result = { ok: false, error: detail.split(/\r?\n/)[0] || 'unknown error' };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // already gone
      }
    }
  }
  probeCache.set(bwrapPath, result);
  return result;
}

function findBwrap() {
  try {
    const out = execFileSync('command', ['-v', 'bwrap'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || null;
  } catch {
    return null;
  }
}

function buildBwrapArgs(cap, { warnings = [] } = {}) {
  const args = [];

  args.push('--unshare-all');
  args.push('--die-with-parent');
  args.push('--new-session');

  // Scratch tmpfs so writes don't persist past the child. Before the binds,
  // not after: bwrap applies operations in order, and a tmpfs mounted last
  // would hide the per-run directory the host just wrote the snippet into.
  args.push('--tmpfs', '/tmp');
  args.push('--tmpfs', '/home');

  for (const p of platformFilter(cap.fs?.read ?? [], 'linux')) {
    if (!p) continue;
    // Device nodes can't be bind-mounted. --dev-bind-try so
    // missing ones don't fail the spawn.
    if (p === '/dev/null') args.push('--dev-bind', p, p);
    else if (p === '/dev/urandom' || p === '/dev/random') {
      args.push('--dev-bind-try', p, p);
    } else {
      args.push('--ro-bind-try', p, p);
    }
  }

  for (const p of platformFilter(cap.fs?.write ?? [], 'linux')) {
    if (!p) continue;
    args.push('--bind-try', p, p);
  }

  // After the writable binds, since bwrap applies operations in order. Mostly
  // the already-cached model files, one bind each.
  //
  // Unverified: nothing here has run against a real bwrap, and there is no
  // bwrap equivalent of the macOS symlink-creation deny.
  for (const p of platformFilter(cap.fs?.readOnly ?? [], 'linux')) {
    if (!p) continue;
    args.push('--ro-bind-try', p, p);
  }

  // With no /dev/snd bound there is no capture device, so the child gets an
  // open error rather than the silence macOS returns.
  if (cap.device?.microphone) {
    args.push('--dev-bind-try', '/dev/snd', '/dev/snd');
    warnings.push('linux sandbox: microphone access granted to this run');
  }
  if (cap.device?.camera) {
    args.push('--dev-bind-try', '/dev/video0', '/dev/video0');
    warnings.push('linux sandbox: camera access granted to this run');
  }

  // Network: unshare-all drops net; share only when mode is not 'none'.
  // bwrap cannot filter by domain — mode 'all' / 'localhost' both share the host net.
  const netMode = cap.network?.mode || 'all';
  if (netMode === 'none') {
    warnings.push('linux sandbox: network.mode=none (no --share-net)');
  } else {
    args.push('--share-net');
    if (netMode === 'localhost') {
      warnings.push(
        'linux sandbox: network.mode=localhost not enforceable in bwrap; using full host net',
      );
    } else if (Array.isArray(cap.network?.hosts) && cap.network.hosts.length > 0) {
      warnings.push(
        'linux sandbox: network.mode=all; hosts[] is documentation only',
      );
    }
  }

  if (Array.isArray(cap.exec) && cap.exec.length > 0) {
    const { found, missing } = resolveExecNames(cap.exec);
    for (const m of missing) {
      warnings.push(
        `linux sandbox: exec binary "${m}" not on PATH; bwrap does not ` +
          'enforce per-binary exec, this entry is documentation only',
      );
    }
    if (found.length > 0) {
      warnings.push(
        'linux sandbox: bwrap does not enforce per-binary exec; the listed ' +
          `binaries (${found.join(', ')}) are bound into the namespace but ` +
          "any binary in the namespace can be execve'd",
      );
    }
  }

  args.push('--process', '0');

  return args;
}

/**
 * @param {Capability} cap
 * @param {string} command
 * @param {string[]} [childArgs]
 * @param {{ bwrapPath?: string }} [options]
 * @returns {LinuxWrap}
 */
function buildWrap(cap, command, childArgs = [], { bwrapPath = DEFAULT_BWRAP } = {}) {
  const warnings = [];
  const resolved = bwrapPath || findBwrap();
  if (!resolved) {
    warnings.push(
      'linux sandbox: bwrap not on PATH; install bubblewrap to enable peer-exec',
    );
    return {
      command,
      args: childArgs,
      env: {},
      warnings,
      bwrapMissing: true,
      namespacesUnavailable: false,
      seccompUnavailable: false,
    };
  }
  // No table for this architecture means no filter, and an unfiltered child
  // keeps ptrace and the mount calls. Refuse instead.
  const filter = seccomp.buildFilter();
  if (!filter) {
    warnings.push(
      `linux sandbox: no seccomp syscall table for ${process.arch}; ` +
        'peer-exec needs one to deny ptrace and the mount calls',
    );
    return {
      command,
      args: childArgs,
      env: {},
      warnings,
      bwrapMissing: false,
      namespacesUnavailable: false,
      seccompUnavailable: true,
    };
  }

  const probe = probeNamespaces(resolved, filter);
  if (!probe.ok) {
    warnings.push(
      `linux sandbox: ${resolved} cannot create a filtered user namespace (${probe.error}); ` +
        'enable unprivileged user namespaces to enable peer-exec',
    );
    return {
      command,
      args: childArgs,
      env: {},
      warnings,
      bwrapMissing: false,
      namespacesUnavailable: true,
      seccompUnavailable: false,
    };
  }

  const bwrapArgs = buildBwrapArgs(cap, { warnings });
  return {
    command: resolved,
    args: [...bwrapArgs, '--seccomp', String(SECCOMP_FD), '--', command, ...childArgs],
    env: {},
    warnings,
    bwrapMissing: false,
    namespacesUnavailable: false,
    seccompUnavailable: false,
    // The spawning side turns this into SECCOMP_FD; bwrap takes no other form.
    seccompFilter: filter,
  };
}

module.exports = {
  buildBwrapArgs,
  buildWrap,
  findBwrap,
  probeNamespaces,
  openSeccompFd,
  DEFAULT_BWRAP,
  SECCOMP_FD,
};
