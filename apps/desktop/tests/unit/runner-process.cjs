'use strict';

// Containment of the buildLesson fixture-path rewrite; the local runner
// executes the rewritten source without a sandbox, so an escape from the courses directory reaches whatever the user account can see.

const test = require('brittle');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildLesson } = require('../../electron/runner-process.cjs');
const { qvacSdkToken, bareBuiltinToken } = require('../../shared/portable-lesson-imports.cjs');

const COURSES = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-process-'));

test('buildLesson - a normal examples/ rewrite stays under coursesDir', (t) => {
  fs.mkdirSync(path.join(COURSES, 'examples', 'lesson-a'), { recursive: true });
  fs.writeFileSync(path.join(COURSES, 'examples', 'lesson-a', 'main.ts'), 'export {};\n');
  const built = buildLesson({
    source: "import x from 'examples/lesson-a/main.ts';\n",
    cwd: COURSES,
  });
  t.ok(built.includes(path.join(COURSES, 'examples', 'lesson-a', 'main.ts')));
  t.teardown(() => fs.rmSync(COURSES, { recursive: true, force: true }));
});

test('buildLesson - a traversal in the rewrite is refused, not silently joined', (t) => {
  // path.join would collapse `..` outside coursesDir; the rewrite refuses instead.
  t.exception(() => {
    buildLesson({
      source: "import x from 'examples/../../../../etc/passwd';\n",
      cwd: COURSES,
    });
  }, /refused path outside coursesDir/);
});

// An earlier parser sliced the wrong characters when the handler body ran onto a second line and rebuilt the call from the pieces.
test('buildLesson - wrapping the entry call leaves its handler intact', (t) => {
  t.teardown(() => fs.rmSync(COURSES, { recursive: true, force: true }));
  const source = "async function main() {}\nmain().catch((err) => \\\n  console.error(err));\n";
  const built = buildLesson({ source, cwd: COURSES, runtime: 'node' });
  t.ok(
    built.includes("__academyFinish(main().catch((err) => \\\n  console.error(err)));"),
    'the handler survives the wrap',
  );
  t.ok(built.includes("process.on('unhandledRejection'"), 'preamble installs the teardown');
});

// peer-exec builds on the sender and runs on the peer; a require.resolve()'d
// path from the sender's own node_modules doesn't exist there.
test('buildLesson - portable mode emits tokens, no local node_modules path', (t) => {
  const built = buildLesson({ source: 'main();\n', cwd: COURSES, runtime: 'node', portable: true });
  t.ok(built.includes(qvacSdkToken()));
  t.absent(built.includes(__dirname), 'no path from this machine leaked in');
  // __dirname alone would miss a leak to node_modules, which lives outside
  // this test file's own directory; dedupePreamble's fs/path imports did
  // exactly that until it started threading `portable` through.
  t.absent(built.includes('node_modules'), 'no node_modules path leaked in');
});

// A lesson importing both @qvac/sdk and another npm dependency (an MCP
// client library) used to get two competing imports for @qvac/sdk's names:
// the generic npm-package fallback tokenized it a second time.
test('buildLesson - portable mode does not double-import @qvac/sdk names', (t) => {
  const source = [
    'import { loadModel } from "@qvac/sdk";',
    'import { Client } from "@modelcontextprotocol/sdk/client/index.js";',
    'loadModel(); Client;',
  ].join('\n');
  const built = buildLesson({ source, cwd: COURSES, runtime: 'node', portable: true });
  t.is((built.match(/\bloadModel\b/g) || []).length, 2, 'declared once, used once');
  t.is(built.split('\n').filter((l) => l.includes(qvacSdkToken())).length, 1, 'one import line for @qvac/sdk');
});

test('buildLesson - portable mode covers the bare runtime preamble too', (t) => {
  const built = buildLesson({ source: 'main();\n', cwd: COURSES, runtime: 'bare', portable: true });
  t.ok(built.includes(qvacSdkToken()));
  t.ok(built.includes(bareBuiltinToken('bare-process')));
  t.ok(built.includes(bareBuiltinToken('bare-fs')), 'dedupePreamble\'s fs import is also a token');
  t.absent(built.includes(__dirname), 'no path from this machine leaked in');
  t.absent(built.includes('node_modules'), 'no node_modules path leaked in');
});
