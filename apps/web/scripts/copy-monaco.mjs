#!/usr/bin/env node
// Copy the bundled Monaco editor's AMD loader (min/vs) into the public assets
// so the renderer can load it from /monaco/vs. Without this, @monaco-editor/
// react fetches the loader from cdn.jsdelivr.net at runtime, which the renderer
// CSP would have to allow — defeating the supply-chain rule the protocol scheme
// was chosen to enforce.

import { existsSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// monaco-editor is a workspace dep hoisted to the repo root by pnpm. Walk up
// from apps/web until we find it; createRequire with pnpm symlinks would
// resolve to the package entry rather than the literal package.json.
function findMonacoPkgJson(start) {
  let dir = start;
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(dir, 'node_modules', 'monaco-editor', 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const monacoPkg = findMonacoPkgJson(__dirname);
if (!monacoPkg) {
  console.error('[monaco] could not find monaco-editor/package.json');
  process.exit(1);
}
const vsSrc = resolve(dirname(monacoPkg), 'min', 'vs');
const vsDest = resolve(__dirname, '..', 'public', 'monaco', 'vs');

await rm(vsDest, { recursive: true, force: true });
await mkdir(dirname(vsDest), { recursive: true });
await cp(vsSrc, vsDest, { recursive: true });
console.log(`[monaco] copied ${vsSrc} -> ${vsDest}`);
