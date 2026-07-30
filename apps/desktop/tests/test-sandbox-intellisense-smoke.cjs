'use strict';

// Structural check on the sandbox .d.ts files. We don't run tsc here;
// this catches the common regressions: function added without a
// declaration, parameter renamed in the .cjs but not the .d.ts, etc.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.resolve(__dirname, '../electron/sandbox');

function read(name) {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

// Normalize whitespace so signatures split across multiple lines
// are still matchable.
const normalize = (s) => s.replace(/\s+/g, ' ').trim();

const idx = normalize(read('index.d.ts'));
// capabilities param can be `string | Capability` (legacy) or
// `ProductName | Capability` (current). Match either.
assert.ok(
  /export function wrapSpawn\s*\(\s*command:\s*string,?\s*args:\s*string\[\],?\s*options:\s*WrapOptions,?\s*capabilities:\s*([A-Za-z_]\w*|string)\s*\|\s*Capability,?\s*\):\s*WrapResult/.test(idx),
  'index.d.ts wrapSpawn must take (command, args, options, capabilities) and return WrapResult',
);
assert.ok(idx.includes('export type {') && idx.includes('WrapResult') && idx.includes('WrapOptions'),
  'index.d.ts must re-export WrapResult and WrapOptions from @academy/sandbox-types');
console.log('[test-sandbox-intellisense] index.d.ts wrapSpawn signature: PASS');

const cap = normalize(read('capabilities.d.ts'));
assert.ok(cap.includes('export const CAPABILITIES:'),
  'capabilities.d.ts must declare CAPABILITIES');
assert.ok(cap.includes('export type {') && cap.includes('Capability') && cap.includes('FsCapability') && cap.includes('NetworkCapability') && cap.includes('EnvCapability'),
  'capabilities.d.ts must re-export the core capability interfaces from @academy/sandbox-types');
console.log('[test-sandbox-intellisense] capabilities.d.ts core types: PASS');

assert.ok(/export function platformFilter\s*\(\s*entries:\s*string\[\]\s*\|\s*undefined,\s*platform:\s*NodeJS\.Platform,?\s*\):\s*string\[\]/.test(cap),
  'platformFilter must take (string[]?, NodeJS.Platform) -> string[]');
assert.ok(/export function expandDeep<T\s*=\s*unknown>\s*\(\s*value:\s*T,?\s*scope\?:\s*TemplateVars,?\s*\):\s*T/.test(cap),
  'expandDeep must be generic');
console.log('[test-sandbox-intellisense] capability function signatures: PASS');

const mac = normalize(read('sandbox-mac.d.ts'));
assert.ok(/export function buildProfile\s*\(\s*capabilityName\?:\s*string,?\s*\):\s*string/.test(mac),
  'sandbox-mac buildProfile signature');
assert.ok(/export function writeProfile\s*\(\s*profile:\s*string,?\s*options\?:\s*\{\s*tmpdir\?:\s*string\s*\},?\s*\):\s*string/.test(mac),
  'sandbox-mac writeProfile signature');
assert.ok(/export function buildWrap\s*\(\s*profilePath:\s*string,?\s*command:\s*string,?\s*args\?:\s*string\[\],?\s*\):\s*MacWrap/.test(mac),
  'sandbox-mac buildWrap signature');
assert.ok(mac.includes('export type {') && mac.includes('MacWrap'),
  'sandbox-mac MacWrap must be re-exported from @academy/sandbox-types');
console.log('[test-sandbox-intellisense] sandbox-mac.d.ts: PASS');

const linux = normalize(read('sandbox-linux.d.ts'));
assert.ok(/export function buildWrap\s*\(\s*cap:\s*Capability,?\s*command:\s*string,?\s*childArgs\?:\s*string\[\],?\s*options\?:\s*\{\s*bwrapPath\?:\s*string\s*\},?\s*\):\s*LinuxWrap/.test(linux),
  'sandbox-linux buildWrap signature');
assert.ok(linux.includes('export type {') && linux.includes('LinuxWrap'),
  'sandbox-linux LinuxWrap must be re-exported from @academy/sandbox-types');
console.log('[test-sandbox-intellisense] sandbox-linux.d.ts: PASS');

const win = normalize(read('sandbox-windows.d.ts'));
assert.ok(/export function buildWrap\s*\(\s*cap:\s*Capability,?\s*command:\s*string,?\s*childArgs\?:\s*string\[\],?\s*\):\s*WindowsWrap/.test(win),
  'sandbox-windows buildWrap signature');
assert.ok(win.includes('export type {') && win.includes('WindowsWrap'),
  'sandbox-windows WindowsWrap must be re-exported from @academy/sandbox-types');
console.log('[test-sandbox-intellisense] sandbox-windows.d.ts: PASS');

assert.ok(/export function loadDynamicCapabilities\s*\(\s*filePath:\s*string,?\s*\):\s*DynamicCapabilityFile\s*\|\s*null/.test(cap),
  'loadDynamicCapabilities must return DynamicCapabilityFile | null');
assert.ok(/export function mergeCapabilities\s*\(\s*base:\s*Capability,?\s*dynamic:\s*DynamicCapabilityFile,?\s*\):\s*Capability/.test(cap),
  'mergeCapabilities must take DynamicCapabilityFile and return Capability');
console.log('[test-sandbox-intellisense] dynamic API types: PASS');

console.log('[test-sandbox-intellisense] PASS');
