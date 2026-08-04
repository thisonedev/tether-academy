'use strict';

// Fail-closed posture: wrapSpawn reports whether this platform got a sandbox,
// and peer.cjs refuses when it did not; the correct answer differs per platform.

const test = require('brittle');

const sandbox = require('../../workers/sandbox/index.cjs');
const { CAPABILITIES } = require('../../workers/sandbox/capabilities.cjs');

const wrap = () => sandbox.wrapSpawn(process.execPath, ['-e', '0'], {}, CAPABILITIES.qvac);

test('sandbox-availability - macOS always has seatbelt', { skip: process.platform !== 'darwin' }, (t) => {
  const w = wrap();
  t.is(w.sandboxed, true, `expected a real sandbox, got mode=${w.mode}`);
});

// sandbox-exec(1) is the whole macOS boundary, so a build that stops shipping it must say so, rather than surface as an ordinary spawn error later.
test('sandbox-availability - a missing sandbox-exec is reported, not assumed', { skip: process.platform !== 'darwin' }, (t) => {
  const mac = require('../../workers/sandbox/sandbox-mac.cjs');

  const present = mac.buildWrap('/tmp/profile.sb', '/bin/echo', ['hi']);
  t.is(present.sandboxExecMissing, false);
  t.is(present.command, '/usr/bin/sandbox-exec', 'the wrap goes through seatbelt');

  // fs.existsSync on the real path is as close as a unit test gets to the OS having dropped it.
  const realExists = require('node:fs').existsSync('/usr/bin/sandbox-exec');
  t.ok(realExists, 'this macOS still ships it; the day it does not, the flag flips');
});

// bwrap may be absent, or present on a kernel that refuses it a namespace; either way the flag must match reality.
test('sandbox-availability - Linux reports honestly whether bwrap works', { skip: process.platform !== 'linux' }, (t) => {
  const w = wrap();
  if (w.mode === 'linux-passthrough') {
    t.is(w.sandboxed, false, 'no bwrap means not sandboxed');
  } else if (w.mode === 'linux-no-userns') {
    t.is(w.sandboxed, false, 'a bwrap that cannot unshare confines nothing');
    t.ok(w.warnings.some((warning) => /user namespace/i.test(warning)), 'and says so');
  } else {
    t.is(w.sandboxed, true, `bwrap present and working, mode=${w.mode}`);
  }
});

// The probe spawns the binary instead of stat-ing it, so a path that cannot
// unshare has to come back refused.
test('sandbox-availability - the namespace probe rejects a binary that cannot unshare', { skip: process.platform !== 'linux' }, (t) => {
  const { probeNamespaces } = require('../../workers/sandbox/sandbox-linux.cjs');
  const bogus = probeNamespaces('/bin/false');
  t.is(bogus.ok, false);
  t.ok(bogus.error, 'the refusal carries the reason');
});

test('sandbox-availability - Windows reports unavailable and explains why', { skip: process.platform !== 'win32' }, (t) => {
  const w = wrap();
  t.is(w.sandboxed, false);
  t.is(w.mode, 'windows-unavailable');
  t.ok(
    w.warnings.some((warning) => /disabled|unavailable|AppContainer/i.test(warning)),
    'refusal names the missing mechanism',
  );
});
