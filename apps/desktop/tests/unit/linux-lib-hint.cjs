'use strict';

// Native addon dlopen failures on Linux name the missing .so in plain text;
// this turns that into an apt install command instead of a dead end.

const test = require('brittle');

const { hintForMissingLib, checkRequiredLinuxLibs } = require('../../shared/linux-lib-hint.cjs');

test('linux-lib-hint - known lib gets an install command', (t) => {
  const hint = hintForMissingLib('libvulkan.so.1: cannot open shared object file: No such file or directory');
  t.ok(hint.includes('libvulkan.so.1'));
  t.ok(hint.includes('apt-get install -y libvulkan1 mesa-vulkan-drivers'));
});

test('linux-lib-hint - matches inside a larger stack trace', (t) => {
  const text = `Uncaught Error: libatomic.so.1: cannot open shared object file: No such file or directory
    at Addon.load (bare:/bare.js:3570:16)`;
  const hint = hintForMissingLib(text);
  t.ok(hint.includes('sudo apt-get install -y libatomic1'));
});

test('linux-lib-hint - unknown lib still gets a hint, no install command guessed', (t) => {
  const hint = hintForMissingLib('libfoo.so.3: cannot open shared object file: No such file or directory');
  t.ok(hint.includes('libfoo.so.3'));
  t.ok(hint.includes('temp/linux.md'));
});

test('linux-lib-hint - no match returns null', (t) => {
  t.is(hintForMissingLib('RPC_INIT_TIMEOUT: RPC initialization timed out after 30000ms'), null);
  t.is(hintForMissingLib(''), null);
  t.is(hintForMissingLib(undefined), null);
});

test('linux-lib-hint - checkRequiredLinuxLibs is a no-op off Linux', { skip: process.platform === 'linux' }, (t) => {
  t.is(checkRequiredLinuxLibs(), null);
});
