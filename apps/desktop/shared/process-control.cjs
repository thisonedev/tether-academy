// @ts-check
'use strict';

// Mac and linux share the POSIX backend, since both signal a process group.
// Windows needs its own because it has no group signal.

const process = require('process');

const impl = process.platform === 'win32'
  ? require('./process-control-windows.cjs')
  : require('./process-control-posix.cjs');

module.exports = {
  killTree: impl.killTree,
  killPid: impl.killPid,
  listProcesses: impl.listProcesses,
  spawnFlags: impl.spawnFlags,
};
