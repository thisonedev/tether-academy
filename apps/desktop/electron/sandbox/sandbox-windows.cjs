// @ts-check
'use strict';

// Windows has no public per-process API comparable to macOS
// sandbox-exec or Linux bwrap. The two real options:
//
//   1. AppContainer (PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES in
//      CreateProcessW). Real per-app isolation, but the network
//      filter is coarse (per-app, not per-domain) and needs
//      New-AppContainerProfile in PowerShell + netsh firewall rules.
//   2. Restricted token + Job object. Best-effort, no per-path or
//      per-domain enforcement.
//
// We ship option 2 (passthrough) because it works on every supported
// Windows version with zero setup. The audit log records the gap so
// the operator can decide to add AppContainer later.

const { resolveExecNames } = require('./capabilities.cjs');

function supportsAppContainer() {
  return process.platform === 'win32';
}

function passthrough(command, childArgs) {
  return {
    command,
    args: childArgs,
    env: {},
    warnings: [
      'windows sandbox: best-effort mode (passthrough). The child runs ' +
        'with the host process token. Real AppContainer isolation is not ' +
        'implemented; see sandbox-windows.cjs for the gap and the ' +
        'PowerShell commands to enable it manually.',
    ],
    mode: 'passthrough',
  };
}

function buildWrap(cap, command, childArgs = []) {
  const warnings = [];

  if (Array.isArray(cap.exec) && cap.exec.length > 0) {
    const { found, missing } = resolveExecNames(cap.exec);
    for (const m of missing) {
      warnings.push(
        `windows sandbox: exec binary "${m}" not on PATH; best-effort ` +
          'mode does not enforce per-binary exec',
      );
    }
    if (found.length > 0) {
      warnings.push(
        'windows sandbox: best-effort mode does not enforce per-binary ' +
          `exec; the listed binaries (${found.join(', ')}) will run unfiltered`,
      );
    }
  }
  if (Array.isArray(cap.network?.allow) && cap.network.allow.length > 0) {
    warnings.push(
      'windows sandbox: best-effort mode does not enforce per-domain ' +
        'network allowlist; outbound traffic is unrestricted. AppContainer ' +
        'would require netsh firewall rules per app profile.',
    );
  }
  if (Array.isArray(cap.fs?.write) && cap.fs.write.length > 0) {
    warnings.push(
      'windows sandbox: best-effort mode does not enforce per-path file ' +
        'write allowlist. AppContainer + NTFS ACLs on a per-spawn working ' +
        'directory would be required for write enforcement.',
    );
  }

  return {
    ...passthrough(command, childArgs),
    warnings: [...warnings, ...passthrough(command, childArgs).warnings],
  };
}

module.exports = {
  buildWrap,
  passthrough,
  supportsAppContainer,
};
