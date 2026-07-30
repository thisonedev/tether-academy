// @ts-check
'use strict';

// Linux per-spawn sandbox via bubblewrap (bwrap). Creates a new user
// + mount + PID namespace; per-path enforcement works because the
// mount namespace only sees what we bind in. Needs unprivileged user
// namespaces (default on most desktop distros, sometimes disabled on
// servers). If bwrap is missing or fails, the platform module
// returns a passthrough with a warning so the audit log records the
// gap rather than silently running unsandboxed.
//
// Gap: bwrap can't restrict which binaries the child can execve.
// Per-binary exec on Linux needs a seccomp filter, out of scope here.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const {
  getCapabilities,
  expandDeep,
  defaultTemplateVars,
  platformFilter,
  resolveExecNames,
} = require('./capabilities.cjs');

const DEFAULT_BWRAP = '/usr/bin/bwrap';

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

  // Scratch tmpfs so writes don't persist past the child. The
  // capability's tmpDir template resolves to the real /tmp path
  // on Linux, so the child can find it.
  args.push('--tmpfs', '/tmp');
  args.push('--tmpfs', '/home');

  // Whole-socket share; per-domain would need a netns proxy.
  args.push('--share-net');

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

function buildWrap(cap, command, childArgs = [], { bwrapPath = DEFAULT_BWRAP } = {}) {
  const warnings = [];
  const resolved = bwrapPath || findBwrap();
  if (!resolved) {
    warnings.push(
      'linux sandbox: bwrap not on PATH; child will run WITHOUT sandbox ' +
        'enforcement. Install bubblewrap (apt/dnf/pacman: bubblewrap) to ' +
        'enable the sandbox.',
    );
    return {
      command,
      args: childArgs,
      env: {},
      warnings,
      bwrapMissing: true,
    };
  }
  const bwrapArgs = buildBwrapArgs(cap, { warnings });
  return {
    command: resolved,
    args: [...bwrapArgs, '--', command, ...childArgs],
    env: {},
    warnings,
    bwrapMissing: false,
  };
}

module.exports = {
  buildBwrapArgs,
  buildWrap,
  findBwrap,
  DEFAULT_BWRAP,
};
