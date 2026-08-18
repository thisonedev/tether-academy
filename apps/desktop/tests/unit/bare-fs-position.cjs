'use strict';

// `readSync(fd, buf, off, len, null)` means "current position, then advance it"
// under Node, so a test suite run under Node passes either way. Bare's binding
// does neither and never returns 0, leaving the loop on the first chunk
// forever. Only reading the source catches that.

const test = require('brittle');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '../..');

// Loaded by the Bare worker, directly or through shared/.
const BARE_LOADED = ['workers', 'shared'];

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.name === 'node_modules') return [];
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(cjs|js|mjs)$/.test(entry.name) ? [full] : [];
  });
}

// The 5th argument is the position. Matches it spanning lines, since the call
// is often wrapped.
const READ_SYNC_NULL_POSITION = /\breadSync\s*\([^)]*,\s*null\s*\)/s;

test('bare-fs-position - Bare-loaded code never reads from a null position', (t) => {
  const offenders = [];
  for (const dir of BARE_LOADED) {
    for (const file of sourceFiles(path.join(APP, dir))) {
      const src = fs.readFileSync(file, 'utf8');
      if (READ_SYNC_NULL_POSITION.test(src)) {
        offenders.push(path.relative(APP, file));
      }
    }
  }

  t.alike(
    offenders,
    [],
    `these loop forever under Bare; track the position and pass it:\n${offenders.join('\n')}`,
  );
});

// Guards the guard: a regex that matched nothing would pass this file silently.
test('bare-fs-position - the check actually recognises the shape it forbids', (t) => {
  t.ok(
    READ_SYNC_NULL_POSITION.test('const read = fs.readSync(fd, buf, 0, buf.length, null);'),
    'flags a null position',
  );
  t.absent(
    READ_SYNC_NULL_POSITION.test('const read = fs.readSync(fd, buf, 0, buf.length, position);'),
    'allows an explicit position',
  );
});
