'use strict';

// Containment of the buildLesson fixture-path rewrite; the local runner
// executes the rewritten source without a sandbox, so an escape from the courses directory reaches whatever the user account can see.

const test = require('brittle');
const { spawn } = require('node:child_process');
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
  t.is((built.match(/loadModel as __academySdk_loadModel/g) || []).length, 1, 'imported once');
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

// A run that prints nothing while it waits should still say what it waits on.
test('buildLesson - a slow SDK call names itself while it runs', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-trace-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  // loadModel is slow here too, and stays silent: every lesson calls it, so
  // its row told you nothing about this run.
  fs.writeFileSync(
    path.join(dir, 'sdk.mjs'),
    'export const loadModel = async () => { await new Promise((r) => setTimeout(r, 500)); return "m1"; };\n'
      + 'export const completion = async () => { await new Promise((r) => setTimeout(r, 500)); return { events: [] }; };\n'
      + 'export const embed = () => [];\n'
      + 'export const close = async () => {};\n',
  );
  const built = buildLesson({
    source:
      'import { loadModel, completion, embed } from "@qvac/sdk";\n'
      + 'async function main() { const m = await loadModel({ modelSrc: 1, ctx: 2 }); await completion({ modelId: m, history: 3 }); embed({ text: 1 }); }\n'
      + 'main();\n',
    cwd: COURSES,
  }).replace(/^import \{[^}]*\} from ".*";$/m, (line) => line.replace(/from ".*";$/, 'from "./sdk.mjs";'));
  fs.writeFileSync(path.join(dir, 'lesson.mjs'), built);

  const child = spawn(process.execPath, [path.join(dir, 'lesson.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  t.teardown(() => clearTimeout(timer));
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  await new Promise((resolve) => child.on('exit', resolve));
  clearTimeout(timer);

  t.ok(/^→ completion\(\{ modelId, history \}\)$/m.test(err), 'the open call names itself and its arguments');
  t.ok(/^ {2}✓ completion \(0\.\d+s\)$/m.test(err), 'and closes with what it cost');
  t.absent(/embed/.test(err), 'a call that returns at once is not worth a line');
  t.absent(/loadModel/.test(err), 'and the call every lesson makes is never worth one');
});

// Carrying `type X` into the injected import and the trace binding emitted
// `const { type X } = ...`, which is a SyntaxError.
test('buildLesson - a type-only specifier stays out of the runtime binding', (t) => {
  const built = buildLesson({
    source:
      'import { loadModel, type RagEmbeddedDoc } from "@qvac/sdk";\n'
      + 'const docs = [] as RagEmbeddedDoc[];\n'
      + 'main();\n',
    cwd: COURSES,
    runtime: 'bare',
  });
  t.absent(/type RagEmbeddedDoc/.test(built), 'the type name is gone from the generated code');
  t.ok(built.includes('loadModel as __academySdk_loadModel'), 'the value import survives');
});

// 20 of the 76 lessons are written as top-level await with no entry call.
// Without a finish appended after the body, nothing told the host the lesson
// ended and the run sat open until something else stopped it.
test('buildLesson - a top-level-await lesson still reports that it finished', (t) => {
  const built = buildLesson({
    source: 'const id = await loadModel({});\nawait unloadModel({ id });\n',
    cwd: COURSES,
    runtime: 'node',
  });
  t.ok(built.includes('__academyFinish(Promise.resolve());'), 'the body is followed by a finish');
  t.ok(
    built.indexOf('__academyFinish(Promise.resolve());') > built.indexOf('await unloadModel'),
    'placed after the lesson, so it waits on it',
  );
});
