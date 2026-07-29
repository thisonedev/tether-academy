'use strict';

if (process.platform === 'darwin') {
  const { app } = require('electron');
  if (app.dock) app.dock.hide();
}
