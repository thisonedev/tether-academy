'use strict';

// --require'd into a node-runtime exec child on macOS. Electron claims a Dock
// icon per run otherwise, even under ELECTRON_RUN_AS_NODE.
if (process.platform === 'darwin') {
  const { app } = require('electron');
  if (app && app.dock) app.dock.hide();
}
