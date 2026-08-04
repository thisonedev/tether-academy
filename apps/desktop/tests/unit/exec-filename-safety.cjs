'use strict';

// Host-side exec fileName validation and argv caps. A peer must not be able to
// talk the host into writing outside its scratch dir, e.g. dropping a plist
// into ~/Library/LaunchAgents for persistence.

const test = require('brittle');

const peer = require('../../workers/peer/index.cjs');

const { isSafeExecFileName } = peer;

test('exec-filename - accepts plain lesson filenames', (t) => {
  t.is(isSafeExecFileName('snippet.mts'), true);
  t.is(isSafeExecFileName('run-01.mjs'), true);
  t.is(isSafeExecFileName('lesson.ts'), true);
});

test('exec-filename - rejects traversal and absolute paths', (t) => {
  t.is(isSafeExecFileName('../evil.mts'), false);
  t.is(isSafeExecFileName('..\\evil.mts'), false, 'windows separator too');
  t.is(isSafeExecFileName('foo/bar.mts'), false);
  t.is(isSafeExecFileName('foo\\bar.mts'), false);
  t.is(isSafeExecFileName('/tmp/x.mts'), false);
});

test('exec-filename - rejects unexpected extensions and shapes', (t) => {
  t.is(isSafeExecFileName(''), false);
  t.is(isSafeExecFileName('evil.plist'), false);
  t.is(isSafeExecFileName('x.sh'), false);
  t.is(isSafeExecFileName('.mts'), false, 'extension alone is not a name');
  t.is(isSafeExecFileName('a'.repeat(200) + '.mts'), false, 'length capped');
});

// Belt and braces: the guest rejects these before they ever reach the wire, so
// a malicious build of the *host* is not the only thing standing in the way.
test('exec-filename - guest exec() refuses traversal before sending', (t) => {
  t.exception(
    () =>
      peer.exec({
        peerId: 'deadbeef',
        code: '1',
        mode: 'file',
        fileName: '../../../../Library/LaunchAgents/evil.plist',
      }),
    /fileName/,
  );
});

test('exec-filename - guest exec() caps argv length', (t) => {
  t.exception(
    () =>
      peer.exec({
        peerId: 'deadbeef',
        code: '1',
        mode: 'inline',
        argv: Array.from({ length: 64 }, () => '--x'),
      }),
    /argv/,
  );
});
