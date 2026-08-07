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

const uninstallCmd = command(
  'uninstall',
  flag('--purge', 'also remove the profile encryption keys'),
  flag('--yes', 'skip the confirmation prompt'),
  (cmd) => require('./uninstall').uninstall({ purge: cmd.flags.purge, yes: cmd.flags.yes }).catch(fail),
);

const cli = command('tether-academy', startCmd, installCmd, updateCmd, uninstallCmd);

function main(argv = process.argv.slice(2)) {
  try {
    cli.parse(argv);
  } catch (err) {
    console.error(`tether-academy: ${err?.message ?? err}`);
    console.error('Run `tether-academy --help` to see available commands.');
    process.exitCode = 1;
  }
}

module.exports = { main };
