'use strict';

// Two checks decide whether a lesson can run on a peer: the editor greys the
// option out from the raw source, and the host refuses the built source. They
// look at different text, so this runs both over every course sample and fails
// if they ever disagree.

const test = require('brittle');
const fs = require('node:fs');
const path = require('node:path');

const { BARE_BUILTINS, buildLesson } = require('../../electron/runner-process.cjs');
const { detectNodeOnly, nodeOnlyPackages } = require('../../workers/peer/exec-validate.cjs');
const { nodeOnlyImports, REWRITTEN_BUILTINS } = require('@academy/validation');
const { npxPackages } = require('../../workers/peer/exec-validate.cjs');
const { allowedMcpPackages } = require('../../workers/sandbox/index.cjs');

const COURSES = path.resolve(__dirname, '../../../../packages/courses');

function everySample(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return everySample(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

const samples = everySample(path.join(COURSES, 'examples'));

test('node-only - the corpus is there', (t) => {
  t.ok(samples.length > 100, `expected the full example set, got ${samples.length}`);
});

test('node-only - editor and host agree on every sample', (t) => {
  const disagreed = [];
  const refused = [];

  for (const file of samples) {
    const source = fs.readFileSync(file, 'utf8');
    const built = buildLesson({ source, cwd: COURSES, runtime: 'bare' });
    const editorSide = nodeOnlyImports(source).sort();
    const hostSide = nodeOnlyPackages(built).sort();

    const rel = path.relative(COURSES, file);
    if (JSON.stringify(editorSide) !== JSON.stringify(hostSide)) {
      disagreed.push(`${rel}: editor ${JSON.stringify(editorSide)} vs host ${JSON.stringify(hostSide)}`);
    }
    if (hostSide.length > 0) refused.push(rel);
  }

  t.alike(disagreed, [], `checks disagree:\n${disagreed.join('\n')}`);
  t.comment(`${samples.length - refused.length} of ${samples.length} run on Bare`);
  t.comment(`node runtime: ${refused.join(', ')}`);
});

// Every MCP server the shipped lessons spawn has to be on the allowlist the
// host pre-installs from, or that lesson is refused on a peer.
test('node-only - the course allowlist covers every MCP server the samples use', (t) => {
  const allowed = allowedMcpPackages();
  const wanted = new Set();

  for (const file of samples) {
    const built = buildLesson({ source: fs.readFileSync(file, 'utf8'), cwd: COURSES, runtime: 'node' });
    for (const pkg of npxPackages(built)) wanted.add(pkg);
  }

  t.ok(wanted.size > 0, 'the corpus spawns at least one MCP server');
  t.alike(
    [...wanted].filter((pkg) => !allowed.includes(pkg)),
    [],
    `these would be refused on a peer: allowlist is ${JSON.stringify(allowed)}`,
  );
  t.comment(`MCP servers in the corpus: ${[...wanted].join(', ')}`);
});

test('node-only - the SDK and the Bare shims are never refused', (t) => {
  const plain = buildLesson({
    source: 'import { loadModel } from "@qvac/sdk";\nimport { readFileSync } from "node:fs";\n'
      + 'async function main() { readFileSync("x"); }\nmain().catch(() => {});\n',
    cwd: COURSES,
    runtime: 'bare',
  });

  t.is(detectNodeOnly(plain), null, 'the SDK plus a rewritten node: import is fine');
  t.alike(nodeOnlyImports('import { x } from "@qvac/sdk/llamacpp-completion/plugin";'), []);
  t.alike(nodeOnlyImports('import x from "node:os";'), []);
  t.alike(nodeOnlyImports('import x from "./local.js";'), []);
});

// The editor reads raw specifiers and the build rewrites them, so a builtin
// added to one list and not the other silently changes which lessons a peer
// will take.
test('node-only - both sides rewrite the same builtins', (t) => {
  t.alike(REWRITTEN_BUILTINS.slice().sort(), Object.keys(BARE_BUILTINS).sort());
});

test('node-only - a new third-party import is caught without naming it', (t) => {
  t.alike(nodeOnlyImports('import Redis from "ioredis";'), ['ioredis']);
  t.alike(nodeOnlyImports('import { z } from "@scope/pkg/sub/path.js";'), ['@scope/pkg']);
});
