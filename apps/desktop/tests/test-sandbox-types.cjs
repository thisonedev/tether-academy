'use strict';

// Verify each .d.ts declares every export from its sibling .cjs.
// If a new function lands in a .cjs but not the .d.ts, this fails.

const assert = require('node:assert/strict');

function getExports(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

const cap = getExports('../electron/sandbox/capabilities.cjs');
const capExports = [
  'CAPABILITIES',
  'PRODUCT_NAMES',
  'getCapabilities',
  'defaultTemplateVars',
  'resolveTemplate',
  'expandDeep',
  'platformFilter',
  'resolveExecName',
  'resolveExecNames',
  'loadDynamicCapabilities',
  'mergeCapabilities',
];
for (const name of capExports) {
  assert.ok(name in cap, `capabilities.cjs must export "${name}"`);
}
assert.equal(typeof cap.CAPABILITIES, 'object');
assert.equal(typeof cap.getCapabilities, 'function');
assert.equal(typeof cap.mergeCapabilities, 'function');
console.log('[test-sandbox-types] capabilities.cjs exports: PASS');

const mac = getExports('../electron/sandbox/sandbox-mac.cjs');
const macExports = ['buildProfile', 'writeProfile', 'buildWrap', 'platformFilter', '_allowRules'];
for (const name of macExports) {
  assert.ok(name in mac, `sandbox-mac.cjs must export "${name}"`);
}
assert.equal(typeof mac.buildProfile, 'function');
assert.equal(typeof mac.writeProfile, 'function');
console.log('[test-sandbox-types] sandbox-mac.cjs exports: PASS');

const linux = getExports('../electron/sandbox/sandbox-linux.cjs');
const linuxExports = ['buildBwrapArgs', 'buildWrap', 'findBwrap', 'DEFAULT_BWRAP'];
for (const name of linuxExports) {
  assert.ok(name in linux, `sandbox-linux.cjs must export "${name}"`);
}
console.log('[test-sandbox-types] sandbox-linux.cjs exports: PASS');

const win = getExports('../electron/sandbox/sandbox-windows.cjs');
const winExports = ['buildWrap', 'passthrough', 'supportsAppContainer'];
for (const name of winExports) {
  assert.ok(name in win, `sandbox-windows.cjs must export "${name}"`);
}
console.log('[test-sandbox-types] sandbox-windows.cjs exports: PASS');

const idx = getExports('../electron/sandbox/index.cjs');
const idxExports = ['wrapSpawn', 'listProductNames', 'buildEnv', 'defaultDynamicPath'];
for (const name of idxExports) {
  assert.ok(name in idx, `index.cjs must export "${name}"`);
}
assert.equal(typeof idx.wrapSpawn, 'function');
console.log('[test-sandbox-types] index.cjs exports: PASS');

const fs = require('node:fs');
const path = require('node:path');
const pairs = [
  ['capabilities.cjs', 'capabilities.d.ts'],
  ['sandbox-mac.cjs', 'sandbox-mac.d.ts'],
  ['sandbox-linux.cjs', 'sandbox-linux.d.ts'],
  ['sandbox-windows.cjs', 'sandbox-windows.d.ts'],
  ['index.cjs', 'index.d.ts'],
];
const dir = path.resolve(__dirname, '../electron/sandbox');
for (const [cjs, dts] of pairs) {
  assert.ok(fs.existsSync(path.join(dir, cjs)), `${cjs} must exist`);
  assert.ok(fs.existsSync(path.join(dir, dts)), `${dts} must exist next to ${cjs}`);
  const dtsContent = fs.readFileSync(path.join(dir, dts), 'utf8');
  const mod = require(path.join(dir, cjs));
  for (const exportName of Object.keys(mod)) {
    if (exportName.startsWith('_')) continue; // underscore-prefixed = internal
    const patterns = [
      new RegExp(`export function ${exportName}[<(]`),
      new RegExp(`export const ${exportName}\\b`),
      new RegExp(`export interface ${exportName}\\b`),
      new RegExp(`export type ${exportName}\\b`),
    ];
    const hasMatch = patterns.some((re) => re.test(dtsContent));
    assert.ok(
      hasMatch,
      `${dts} must declare export "${exportName}" from ${cjs}`,
    );
  }
}
console.log('[test-sandbox-types] .d.ts files declare every .cjs export: PASS');

console.log('[test-sandbox-types] PASS');
