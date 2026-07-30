// @ts-check
'use strict';

// macOS per-spawn sandbox via sandbox-exec(1). It is the only public
// macOS API that gives us per-process kernel-level sandboxing. App
// Sandbox is bundle-level (whole app), not per-spawn. sandbox-exec
// is marked "deprecated" but the binary is still in /usr/bin and
// Apple has not announced a removal date.
//
// Gaps: per-domain network filtering (only * and localhost are
// accepted by sandbox-exec) and per-path file-read* (Node + libuv +
// dyld need broad path access at start-up; component-by-component
// path resolution makes strict reads impractical). Documented, not
// bugs. Profile format: sandbox(7), Scheme-style S-expressions.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  getCapabilities,
  expandDeep,
  defaultTemplateVars,
  platformFilter,
  resolveExecNames,
} = require('./capabilities.cjs');

function sbString(s) {
  if (typeof s !== 'string') return '""';
  return JSON.stringify(s);
}

function allowRules(cap, { warnings = [] } = {}) {
  const rules = [];

  // Permissive read. See the file header for the trade-off.
  rules.push('(allow file-read*)');

  for (const p of platformFilter(cap.fs?.write ?? [], 'darwin')) {
    rules.push(`(allow file-write* file-write-create (subpath ${sbString(p)}))`);
  }
  rules.push('(allow file-write* (literal "/dev/null"))');

  const { found: resolvedExec, missing: missingExec } = resolveExecNames(cap.exec ?? []);
  for (const m of missingExec) {
    warnings.push(
      `mac sandbox: exec binary "${m}" not on PATH; process-exec allowlist omits it`,
    );
  }
  const execPaths = new Set(resolvedExec);
  execPaths.add(process.execPath);
  const macOv = cap.platformOverrides?.mac ?? {};
  if (macOv.dockHideShim) execPaths.add(macOv.dockHideShim);
  execPaths.add(path.dirname(process.execPath));
  execPaths.add('/bin/sh');
  execPaths.add('/usr/bin/env');
  for (const p of execPaths) {
    if (!p) continue;
    rules.push(`(allow process-exec (literal ${sbString(p)}))`);
  }

  if (Array.isArray(cap.network?.allow) && cap.network.allow.length > 0) {
    warnings.push(
      'mac sandbox: per-domain network allowlist is not enforceable in ' +
        'sandbox-exec; allowing all outbound (network.allow is documentation only)',
    );
  }
  rules.push('(allow network-outbound (remote ip "*:*"))');
  rules.push('(allow network-outbound (remote unix-socket))');

  for (const name of [
    'hw.physicalcpu', 'hw.logicalcpu', 'hw.memsize', 'hw.pagesize',
    'kern.osversion', 'kern.osrelease', 'kern.ostype', 'kern.version',
    'kern.bootargs', 'kern.maxproc', 'kern.maxfiles',
    'kern.maxfilesperproc', 'kern.argmax', 'kern.posix1version',
    'machdep.cpu.brand_string',
  ]) {
    rules.push(`(allow sysctl-read (sysctl-name ${sbString(name)}))`);
  }

  rules.push('(allow signal)');
  rules.push('(allow mach-lookup)');
  rules.push('(allow iokit-open)');
  rules.push('(allow ipc-posix-shm)');
  rules.push('(allow ipc-sysv-shm)');
  rules.push('(allow process-info*)');

  return rules;
}

function buildProfile(capabilityName = 'qvac') {
  const cap = expandDeep(getCapabilities(capabilityName), defaultTemplateVars());
  return [
    '(version 1)',
    '(deny default)',
    ...allowRules(cap, { warnings: [] }),
  ].join('\n') + '\n';
}

function writeProfile(profile, { tmpdir = os.tmpdir() } = {}) {
  const name = `academy-sandbox-${crypto.randomBytes(6).toString('hex')}.sb`;
  const profilePath = path.join(tmpdir, name);
  fs.writeFileSync(profilePath, profile, { mode: 0o644 });
  return profilePath;
}

function buildWrap(profilePath, command, args = []) {
  return {
    command: '/usr/bin/sandbox-exec',
    args: ['-f', profilePath, command, ...args],
    env: {},
    warnings: [],
  };
}

module.exports = {
  buildProfile,
  writeProfile,
  buildWrap,
  platformFilter,
  _allowRules: allowRules,
};
