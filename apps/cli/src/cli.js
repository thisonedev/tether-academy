'use strict';

const { command, flag } = require('paparam');

const { start } = require('./start');

function fail(err) {
  console.error(`tether-academy: ${err?.message ?? err}`);
  process.exitCode = 1;
}

// paparam pre-fills every declared boolean flag to false, so cmd.flags alone
// can't tell "not passed" from "explicitly false". cmd.indices.flags only has
// an entry for flags actually typed on the command line.
function explicitFlag(cmd, name) {
  return cmd.indices.flags[name] !== undefined ? cmd.flags[name] : undefined;
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
  flag('--purge', 'also remove models, output files, progress, and identity'),
  flag('--yes', 'skip the confirmation prompt'),
  flag('--models', 'also remove downloaded models'),
  flag('--output', 'also remove lesson output files'),
  flag('--progress', 'also remove progress and settings'),
  flag('--identity', 'also remove your identity'),
  (cmd) =>
    require('./uninstall')
      .uninstall({
        purge: cmd.flags.purge,
        yes: cmd.flags.yes,
        models: explicitFlag(cmd, 'models'),
        output: explicitFlag(cmd, 'output'),
        progress: explicitFlag(cmd, 'progress'),
        identity: explicitFlag(cmd, 'identity'),
      })
      .catch(fail),
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
