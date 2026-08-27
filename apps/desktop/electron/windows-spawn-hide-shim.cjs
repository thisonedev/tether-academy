'use strict';

// --require'd into every node-runtime exec child and the Electron main
// process: @qvac/sdk's bare worker and a lesson's ffplay playback both
// spawn with no windowsHide. Patches spawn and spawnSync instead.
if (process.platform === 'win32') {
  const cp = require('node:child_process');
  const addWindowsHide = (options) =>
    options && typeof options === 'object' && options.windowsHide === undefined
      ? { ...options, windowsHide: true }
      : options;
  const originalSpawn = cp.spawn;
  cp.spawn = function windowsHiddenSpawn(command, args, options) {
    return originalSpawn.call(this, command, args, addWindowsHide(options));
  };
  const originalSpawnSync = cp.spawnSync;
  cp.spawnSync = function windowsHiddenSpawnSync(command, args, options) {
    return originalSpawnSync.call(this, command, args, addWindowsHide(options));
  };
}
