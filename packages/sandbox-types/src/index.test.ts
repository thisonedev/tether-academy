// Smoke test: structural assertions on the public type surface
// (types erase at runtime) plus a check that build artefacts exist.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = fileURLToPath(import.meta.url);
const pkgRoot = resolve(here, '..', '..');
const distDir = resolve(pkgRoot, 'dist');

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`[sandbox-types.test] ${name}: PASS`);
  } catch (err) {
    failures++;
    console.error(`[sandbox-types.test] ${name}: FAIL`);
    console.error(`  ${(err as Error).message}`);
  }
}

test('dist/index.d.ts exists', () => {
  assert.ok(existsSync(resolve(distDir, 'index.d.ts')), 'dist/index.d.ts must exist');
});

test('dist/index.js exists', () => {
  assert.ok(existsSync(resolve(distDir, 'index.js')), 'dist/index.js must exist');
});

const readDts = () => readFileSync(resolve(distDir, 'index.d.ts'), 'utf8');

test('dist/index.d.ts declares Capability', () => {
  assert.match(readDts(), /export interface Capability/, 'Capability must be exported');
});

test('dist/index.d.ts declares WrapResult', () => {
  assert.match(readDts(), /export interface WrapResult/, 'WrapResult must be exported');
});

test('dist/index.d.ts declares DynamicCapabilityFile', () => {
  assert.match(readDts(), /export interface DynamicCapabilityFile/, 'DynamicCapabilityFile must be exported');
});

test('dist/index.d.ts declares FsCapability, NetworkCapability, EnvCapability, PlatformOverrides', () => {
  const dts = readDts();
  for (const name of ['FsCapability', 'NetworkCapability', 'EnvCapability', 'PlatformOverrides']) {
    assert.match(dts, new RegExp(`export interface ${name}\\b`), `${name} must be exported`);
  }
});

test('dist/index.d.ts declares TemplateVars', () => {
  assert.match(readDts(), /export interface TemplateVars/, 'TemplateVars must be exported');
});

test('dist/index.d.ts declares PlatformPrefix and PathSpec', () => {
  const dts = readDts();
  assert.match(dts, /export type PlatformPrefix/, 'PlatformPrefix must be exported');
  assert.match(dts, /export type PathSpec/, 'PathSpec must be exported');
});

if (failures > 0) {
  console.error(`\n[sandbox-types.test] ${failures} test(s) failed`);
  process.exit(1);
}
console.log('\n[sandbox-types.test] PASS');
