'use strict';

// The Windows half (shell: true actually reaching execFileSync) needs a real
// win32 host to assert honestly; see temp/windows.md. What runs everywhere is
// the input gate: this is the one argument in that call that isn't a fixed
// literal, so a package name has to clear npm's own naming grammar before it
// can reach a shell on any platform.

const test = require('brittle');
const { NPM_PACKAGE_NAME_RE, warmPackage } = require('../../workers/sandbox/mcp-warm.cjs');

test('mcp-warm - NPM_PACKAGE_NAME_RE accepts real package names', (t) => {
  for (const name of ['left-pad', '@oevortex/ddg_search', 'a', '@scope/pkg.name_2']) {
    t.ok(NPM_PACKAGE_NAME_RE.test(name), name);
  }
});

test('mcp-warm - NPM_PACKAGE_NAME_RE refuses shell metacharacters', (t) => {
  for (const name of ['pkg; rm -rf /', 'pkg && calc', 'pkg | more', 'pkg`whoami`', 'pkg"&whoami', 'pkg%TEMP%', '../escape']) {
    t.absent(NPM_PACKAGE_NAME_RE.test(name), name);
  }
});

test('mcp-warm - warmPackage refuses an invalid name before touching npx or the cache dir', (t) => {
  const cacheDir = `/tmp/academy-mcp-warm-test-${process.pid}-${Date.now()}`;
  const result = warmPackage(cacheDir, 'pkg; rm -rf /');
  t.is(result.ok, false);
  t.ok(result.error.includes('not a valid npm package name'));
  t.absent(require('fs').existsSync(cacheDir), 'never created the cache dir for a refused name');
});
