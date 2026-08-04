'use strict';

// package.json's "imports" map rewrites bare specifiers per runtime (`fs` ->
// `bare-fs` under Bare, `fs` under Node), and a `node:` prefix opts out of
// that map entirely. A `node:` import inside worker or shared code resolves
// under Node, passes review, then throws MODULE_NOT_FOUND the first time a peer runs something.

const test = require('brittle');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '../..');

// Loaded by the Bare worker, directly or through shared/.
const BARE_LOADED = ['workers', 'shared'];

const MAPPED = Object.keys(require('../../package.json').imports ?? {});

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.name === 'node_modules') return [];
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(cjs|js|mjs)$/.test(entry.name) ? [full] : [];
  });
}

test('bare-import-style - the imports map covers what Bare code needs', (t) => {
  t.ok(MAPPED.length > 0, 'package.json declares an imports map');
  for (const name of ['fs', 'path', 'os', 'child_process', 'process', 'events']) {
    t.ok(MAPPED.includes(name), `${name} is mapped`);
  }
});

test('bare-import-style - Bare-loaded code never uses a node: prefix', (t) => {
  const offenders = [];

  for (const root of BARE_LOADED) {
    for (const file of sourceFiles(path.join(APP, root))) {
      const src = fs.readFileSync(file, 'utf8');
      for (const [, spec] of src.matchAll(/require\('(node:[^']+)'\)/g)) {
        // Only mapped names matter: `node:util` is unavailable under Bare either way.
        const bare = spec.slice('node:'.length);
        if (MAPPED.includes(bare)) {
          offenders.push(`${path.relative(APP, file)} requires '${spec}', should be '${bare}'`);
        }
      }
    }
  }

  t.alike(offenders, [], `these would throw under Bare:\n${offenders.join('\n')}`);
});
