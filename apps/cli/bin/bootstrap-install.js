#!/usr/bin/env node
'use strict';

// Used only by install.sh's bootstrap clone. Calls install.js directly
// instead of via cli.js, which requires `paparam` — not installed yet in
// a bare `git clone`.
require('../src/install')
  .install()
  .catch((err) => {
    console.error(`tether-academy: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
