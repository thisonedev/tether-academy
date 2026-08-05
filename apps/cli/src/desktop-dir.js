'use strict';

// apps/cli and apps/desktop are always siblings under apps/, both in this
// monorepo checkout and inside an installed ~/.tether-academy/versions/<sha>
// clone (same repo layout), so a relative path is all that's needed.
const path = require('node:path');

function desktopDir() {
  return path.resolve(__dirname, '..', '..', 'desktop');
}

module.exports = { desktopDir };
