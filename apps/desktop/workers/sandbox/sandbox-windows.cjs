// @ts-check
'use strict';

// Windows has no per-process confinement yet (AppContainer is planned); peer-exec is refused until it lands.

const { resolveExecNames } = require('./capabilities.cjs');

/**
 * @typedef {import('@academy/sandbox-types').Capability} Capability
 * @typedef {import('@academy/sandbox-types').WindowsWrap} WindowsWrap
 */

function buildWrap(cap, command, childArgs = []) {
  const warnings = [
    'windows sandbox: peer-exec disabled until AppContainer confinement ships',
  ];
  if (Array.isArray(cap.exec) && cap.exec.length > 0) {
    const { missing } = resolveExecNames(cap.exec);
    for (const m of missing) {
      warnings.push(`windows sandbox: exec binary "${m}" not on PATH`);
    }
  }
  return {
    command,
    args: childArgs,
    env: {},
    warnings,
    mode: 'windows-unavailable',
    available: false,
  };
}

module.exports = {
  buildWrap,
};
