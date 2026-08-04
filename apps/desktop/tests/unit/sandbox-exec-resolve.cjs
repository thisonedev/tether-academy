'use strict';

// How the sandbox turns a capability's `exec` names into allowlist entries;
// a symlinked entry (seatbelt matches the resolved path) and a GUI launch
// (whose PATH cannot see Homebrew) can each silently produce an unusable one.

const test = require('brittle');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sandbox = require('../../workers/sandbox/index.cjs');
const {
  CAPABILITIES,
  resolveExecName,
  resolveExecNames,
} = require('../../workers/sandbox/capabilities.cjs');
const { _allowRules } = require('../../workers/sandbox/sandbox-mac.cjs');

const notPosix = process.platform === 'win32';

// A real executable plus a symlink to it from another directory, the way
// Homebrew installs one.
function symlinkedTool(t) {
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-tool-real-'));
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-tool-link-'));
  t.teardown(() => {
    fs.rmSync(realDir, { recursive: true, force: true });
    fs.rmSync(linkDir, { recursive: true, force: true });
  });

  const real = path.join(realDir, 'academy-fake-tool');
  fs.writeFileSync(real, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const link = path.join(linkDir, 'academy-fake-tool');
  fs.symlinkSync(real, link);

  // mkdtemp under /var/folders resolves through /private on macOS.
  return { link, real: fs.realpathSync(real), linkDir };
}

test('exec-resolve - a symlinked binary resolves to both paths', { skip: notPosix }, (t) => {
  const { link, real } = symlinkedTool(t);

  const { found, missing } = resolveExecNames([link]);
  t.alike(missing, [], 'an installed binary is not reported missing');
  t.ok(found.includes(real), 'the kernel-resolved path is allowlisted');
  t.ok(found.includes(link), 'the path PATH lookup finds is allowlisted too');
});

test('exec-resolve - a missing binary is reported, not allowlisted', (t) => {
  const { found, missing } = resolveExecNames(['academy-definitely-not-installed']);
  t.alike(found, []);
  t.alike(missing, ['academy-definitely-not-installed']);
});

test('exec-resolve - resolution survives a GUI launch PATH', { skip: notPosix }, (t) => {
  const original = process.env.PATH;
  t.teardown(() => {
    process.env.PATH = original;
  });

  // Finder/dock gives the app no PATH worth the name, so this exercises the fallback directories.
  process.env.PATH = '';
  const resolved = resolveExecName('sh');
  t.ok(resolved && path.isAbsolute(resolved), 'standard bin dirs are searched without PATH');
  t.is(path.basename(resolved), 'sh');
  t.ok(fs.existsSync(resolved), 'and it points at a real binary');
});

test('exec-resolve - mac profile allows exec of the resolved path', { skip: notPosix }, (t) => {
  const { link, real } = symlinkedTool(t);
  const cap = { ...CAPABILITIES.qvac, exec: [link] };

  const rules = _allowRules(cap, { warnings: [] }).join('\n');
  t.ok(
    rules.includes(`(allow process-exec (literal "${real}"))`),
    'seatbelt matches the resolved path, so the rule must name it',
  );
  t.ok(rules.includes(`(allow process-exec (literal "${link}"))`));
});

test('exec-resolve - the child PATH can find its allowlisted binaries', { skip: notPosix }, (t) => {
  const { link, linkDir } = symlinkedTool(t);
  const cap = { ...CAPABILITIES.qvac, exec: [...CAPABILITIES.qvac.exec, link] };

  const wrapped = sandbox.wrapSpawn(process.execPath, ['-e', '0'], { includeBare: true }, cap);
  const dirs = (wrapped.env.PATH || '').split(path.delimiter);

  t.ok(
    dirs.includes(fs.realpathSync(linkDir)) || dirs.includes(linkDir),
    'allowlisting a binary is useless if spawn() cannot find it by name',
  );
});
