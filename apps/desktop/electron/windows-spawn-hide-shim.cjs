'use strict';

// --require'd into every node-runtime exec child, and into the Electron main
// process directly: @qvac/sdk spawns its `bare` worker with no windowsHide,
// popping a console window per model load. Patches spawn instead of the vendored file.
if (process.platform === 'win32') {
  const cp = require('node:child_process');
  const originalSpawn = cp.spawn;
  cp.spawn = function windowsHiddenSpawn(command, args, options) {
    if (options && typeof options === 'object' && options.windowsHide === undefined) {
      options = { ...options, windowsHide: true };
    }
    return originalSpawn.call(this, command, args, options);
  };
}
