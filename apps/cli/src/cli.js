'use strict';

const { command, flag } = require('paparam');

const { start } = require('./start');

function fail(err) {
  console.error(`tether-academy: ${err?.message ?? err}`);
  process.exitCode = 1;
}

const startCmd = command(
  'start',
  flag('--storage [dir]', 'use a custom profile storage directory'),
  (cmd) => start({ storage: cmd.flags.storage }).catch(fail),
);

const installCmd = command('install', () => {
  require('./install').install().catch(fail);
});

const updateCmd = command('update', () => {
  require('./update').update().catch(fail);
});

const cli = command('tether-academy', startCmd, installCmd, updateCmd);

function main(argv = process.argv.slice(2)) {
  cli.parse(argv);
}

module.exports = { main };
