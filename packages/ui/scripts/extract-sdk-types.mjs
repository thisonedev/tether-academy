#!/usr/bin/env node
// Build-time walker for the @qvac/sdk type graph.
//
// At runtime, the Monaco TS worker can't read files; it only sees
// what we register as extraLibs. This script walks the SDK's
// `.d.ts` graph from `index.d.ts`, finds every reachable file
// (skipping the 1.3MB `models/registry` which lessons never need),
// and writes them as a JSON map. The Monaco setup then registers
// each entry as an extraLib at its absolute file URI. TypeScript's
// own module resolver handles the rest.
//
// Zero maintenance: when the SDK ships a new type or function, the
// next build picks it up automatically. No hand-curated d.ts to
// keep in sync, no third-party bundler.

'use strict';

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = path.resolve(__dirname, '..', 'src', 'generated', 'sdk-types-files.json');

// Directories we never ship to the editor. The model registry is
// 1.3MB of metadata lessons never reference.
const SKIP_DIRS = new Set(['models/registry']);

function fileUri(absPath) {
  return 'file://' + absPath;
}

function resolveFrom(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const dir = path.dirname(fromFile);
  const resolved = path.resolve(dir, spec);
  const candidates = [
    resolved,
    resolved + '.d.ts',
    resolved + '.ts',
    path.join(resolved, 'index.d.ts'),
    path.join(resolved, 'index.ts'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function shouldSkip(absPath, sdkRoot) {
  const rel = path.relative(sdkRoot, absPath);
  for (const skip of SKIP_DIRS) {
    if (rel === skip || rel.startsWith(skip + '/') || rel.startsWith(skip + path.sep)) {
      return true;
    }
  }
  return false;
}

function walk(startFile, sdkRoot) {
  const seen = new Map();
  const queue = [startFile];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    if (shouldSkip(file, sdkRoot)) continue;
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    seen.set(file, content);
    // Find relative imports and queue them.
    const importRe = /(?:import|export)\s+(?:type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = importRe.exec(content)) !== null) {
      const spec = m[1];
      const resolved = resolveFrom(file, spec);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
    // Triple-slash references
    const refRe = /\/\/\/\s*<reference\s+path=["']([^"']+)["']/g;
    while ((m = refRe.exec(content)) !== null) {
      const resolved = resolveFrom(file, m[1]);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

// Resolve the SDK the way Node would, from the app that depends on it.
// An upgrade leaves the old version in the store, and taking whichever
// entry readdir returned first silently pinned the stale types.
function findSdkPackageJson() {
  try {
    return createRequire(path.join(REPO_ROOT, 'apps', 'desktop', 'package.json')).resolve(
      '@qvac/sdk/package',
    );
  } catch {
    // Not linked from there; fall back to the store.
  }
  const pnpmDir = path.join(REPO_ROOT, 'node_modules', '.pnpm');
  if (!fs.existsSync(pnpmDir)) return null;
  const match = fs
    .readdirSync(pnpmDir)
    .filter((e) => e.startsWith('@qvac+sdk@'))
    .sort((a, b) => storeVersion(a) - storeVersion(b))
    .pop();
  if (!match) return null;
  return path.join(pnpmDir, match, 'node_modules', '@qvac', 'sdk', 'package.json');
}

// Sorts `@qvac+sdk@0.19.0_<peer hash>` store entries by semver.
function storeVersion(entry) {
  const m = entry.match(/^@qvac\+sdk@(\d+)\.(\d+)\.(\d+)/);
  return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : -1;
}

const sdkPkgJson = findSdkPackageJson();
if (!sdkPkgJson || !fs.existsSync(sdkPkgJson)) {
  // The editor will fail-open on an empty map; log and exit cleanly.
  fs.writeFileSync(OUT, '[]');
  console.log('extract-sdk-types: @qvac/sdk not installed — wrote empty file map');
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(sdkPkgJson, 'utf8'));
const typesRel = pkg.types || pkg.typings;
if (!typesRel) {
  fs.writeFileSync(OUT, '[]');
  console.log('extract-sdk-types: @qvac/sdk has no types entry — wrote empty file map');
  process.exit(0);
}

const sdkRoot = path.dirname(path.resolve(path.dirname(sdkPkgJson), typesRel));
const entry = path.resolve(path.dirname(sdkPkgJson), typesRel);
if (!fs.existsSync(entry)) {
  fs.writeFileSync(OUT, '[]');
  console.log(`extract-sdk-types: @qvac/sdk entry not found: ${entry} — wrote empty file map`);
  process.exit(0);
}

const files = walk(entry, sdkRoot);

// The SDK's d.ts uses Zod (z.input, z.ZodObject, …) for its
// schema-derived types. Without Zod's .d.ts in the lib set, those
// expressions are unresolved and the TS worker can't show
// properties on objects like `LoadModelOptions`. Pull Zod's types
// in alongside the SDK's so module resolution finds them.
function findZodPackageJson() {
  const pnpmDir = path.join(REPO_ROOT, 'node_modules', '.pnpm');
  if (!fs.existsSync(pnpmDir)) return null;
  const entries = fs.readdirSync(pnpmDir);
  // zod 4.x packages itself as `zod@x.y.z` (no scope); zod 3.x was
  // `zod@x.y.z` too. Some pnpm layouts nest under a hash directory.
  for (const e of entries) {
    if (/^zod@/.test(e)) {
      return path.join(pnpmDir, e, 'node_modules', 'zod', 'package.json');
    }
  }
  return null;
}

const zodPkgJson = findZodPackageJson();
if (zodPkgJson && fs.existsSync(zodPkgJson)) {
  const zodPkg = JSON.parse(fs.readFileSync(zodPkgJson, 'utf8'));
  const zodEntry = zodPkg.types || zodPkg.typings || './index.d.ts';
  const zodEntryAbs = path.resolve(path.dirname(zodPkgJson), zodEntry);
  if (fs.existsSync(zodEntryAbs)) {
    const zodFiles = walk(zodEntryAbs, path.dirname(zodEntryAbs));
    for (const [absPath, content] of zodFiles) {
      const rel = path.relative(path.dirname(zodEntryAbs), absPath).split(path.sep).join('/');
      files.set(absPath, content);
    }
  }
}

// 0.19 moved the option and descriptor types into `@qvac/inference`, reached
// by bare subpath imports the relative walker cannot follow. Resolve them
// through that package's own exports map.
function findInferencePackageJson() {
  try {
    return createRequire(path.join(REPO_ROOT, 'apps', 'desktop', 'package.json')).resolve(
      '@qvac/inference/package',
    );
  } catch {
    const pnpmDir = path.join(REPO_ROOT, 'node_modules', '.pnpm');
    if (!fs.existsSync(pnpmDir)) return null;
    const match = fs.readdirSync(pnpmDir).find((e) => e.startsWith('@qvac+inference@'));
    return match
      ? path.join(pnpmDir, match, 'node_modules', '@qvac', 'inference', 'package.json')
      : null;
  }
}

const INFERENCE_SPEC = /from\s+['"](@qvac\/inference(?:\/[^'"]+)?)['"]/g;
const inferenceFiles = new Map();
let inferenceRoot = null;

const inferencePkgJson = findInferencePackageJson();
if (inferencePkgJson && fs.existsSync(inferencePkgJson)) {
  const pkgDir = path.dirname(inferencePkgJson);
  const exportsMap = JSON.parse(fs.readFileSync(inferencePkgJson, 'utf8')).exports ?? {};
  const entryFor = (spec) => {
    const sub = spec === '@qvac/inference' ? '.' : `.${spec.slice('@qvac/inference'.length)}`;
    const target = exportsMap[sub];
    const rel = typeof target === 'string' ? target : target?.types;
    return rel ? path.resolve(pkgDir, rel) : null;
  };

  const rootEntry = entryFor('@qvac/inference');
  inferenceRoot = rootEntry ? path.dirname(rootEntry) : pkgDir;

  // Inference re-exports its own subpaths, so keep resolving until nothing new.
  const done = new Set();
  for (;;) {
    const specs = new Set();
    for (const content of [...files.values(), ...inferenceFiles.values()]) {
      let m;
      INFERENCE_SPEC.lastIndex = 0;
      while ((m = INFERENCE_SPEC.exec(content)) !== null) specs.add(m[1]);
    }
    const pending = [...specs].filter((spec) => !done.has(spec));
    if (pending.length === 0) break;
    for (const spec of pending) {
      done.add(spec);
      const entryAbs = entryFor(spec);
      if (!entryAbs || !fs.existsSync(entryAbs)) continue;
      for (const [abs, content] of walk(entryAbs, inferenceRoot)) inferenceFiles.set(abs, content);
    }
  }
}

const out = [];
// Use a virtual relative URI scheme so the runtime can register
// each file at a stable path regardless of where the build ran.
// `qvac-sdk/index.d.ts` resolves to the SDK's entry; relative
// imports inside the SDK (`./schemas/index`) resolve naturally.
// Zod files land under `qvac-zod/...` to avoid name collisions.
for (const [absPath, content] of files) {
  const inZod = zodPkgJson && absPath.startsWith(path.dirname(zodPkgJson));
  const base = inZod ? 'qvac-zod' : 'qvac-sdk';
  const root = inZod ? path.dirname(zodPkgJson) : sdkRoot;
  const rel = path.relative(root, absPath).split(path.sep).join('/');
  out.push({ path: base + '/' + rel, content });
}

for (const [absPath, content] of inferenceFiles) {
  const rel = path.relative(inferenceRoot, absPath).split(path.sep).join('/');
  out.push({ path: 'qvac-inference/' + rel, content });
}

fs.writeFileSync(OUT, JSON.stringify(out));
const totalKb = Math.round(out.reduce((s, f) => s + f.content.length, 0) / 1024);
console.log(
  `extract-sdk-types: wrote ${out.length} files, ${totalKb} KB to ${path.relative(REPO_ROOT, OUT)}`,
);
