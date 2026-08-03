'use strict';

// A lesson that loaded a model does not end when its last line runs: the SDK's
// worker holds the process open. buildLesson hands the entry call to a teardown
// that closes the SDK and exits, so a finished run reports as finished instead
// of being killed by whichever watchdog notices first.

const test = require('brittle');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildLesson } = require('../../electron/runner-process.cjs');

const COURSES = path.join(__dirname, '..', '..', '..', '..', 'packages', 'courses');

const build = (source) => buildLesson({ source, cwd: COURSES });

test('lesson-exit - the entry call is handed to the teardown', (t) => {
  const built = build('async function main() {}\n\nmain().catch(console.error);\n');
  t.ok(built.includes('__academyFinish(main().catch(console.error));'));
});

test('lesson-exit - a chain split over lines is taken whole', (t) => {
  const built = build(
    'async function main() {}\n\nmain()\n  .then(() => 1)\n  .catch(console.error);\n',
  );
  t.ok(built.includes('__academyFinish(main()\n  .then(() => 1)\n  .catch(console.error));'));
});

// The scan is over source text, so a handler that prints punctuation must not
// read as the end of the statement.
test('lesson-exit - a semicolon inside the handler does not end the statement', (t) => {
  const built = build('async function main() {}\n\nmain().catch(() => console.log("a; b"));\n');
  t.ok(built.includes('__academyFinish(main().catch(() => console.log("a; b")));'));
});

// The provider lesson serves until it is stopped, and the BCI lessons run
// their work at the top level. Neither has an entry call to hang teardown off.
test('lesson-exit - a lesson with no entry call is left alone', (t) => {
  const built = build('const modelId = await loadModel({});\nawait unloadModel({ modelId });\n');
  t.absent(/__academyFinish\(main/.test(built), 'nothing is wrapped');
});

test('lesson-exit - work after the entry call blocks the rewrite', (t) => {
  const built = build('async function main() {}\n\nmain();\nawait serveForever();\n');
  t.absent(/__academyFinish\(main/.test(built), 'exiting here would cut off the last line');
});

// A run whose lesson finished has to end on its own, and everything it
// printed has to survive the exit.
test('lesson-exit - a lesson holding a live handle still exits', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-exit-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  const built = build(
    'async function main() {\n'
    + '  for (let i = 0; i < 2000; i++) console.log("line " + i);\n'
    + '  setInterval(() => {}, 1000);\n'
    + '}\n\nmain().catch(console.error);\n',
  ).replace(/^import \{ close \} from ".*";$/m, 'import { close } from "./sdk.mjs";');

  fs.writeFileSync(path.join(dir, 'sdk.mjs'), 'export const close = async () => console.log("[closed]");\n');
  fs.writeFileSync(path.join(dir, 'lesson.mjs'), built);

  const child = spawn(process.execPath, [path.join(dir, 'lesson.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  t.teardown(() => clearTimeout(timer));

  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const [code, signal] = await new Promise((resolve) => {
    child.on('exit', (c, s) => resolve([c, s]));
  });
  clearTimeout(timer);

  t.is(signal, null, 'the child ended on its own, not on the timeout');
  t.is(code, 0, 'and reports a clean exit');
  t.ok(out.includes('[closed]'), 'the SDK is closed first');
  t.ok(out.includes('line 1999'), 'no output is dropped on the way out');
});

test('lesson-exit - a failed lesson exits non-zero', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-exit-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  const built = build(
    'async function main() {\n  throw new Error("boom");\n}\n\nmain();\n',
  ).replace(/^import \{ close \} from ".*";$/m, 'import { close } from "./sdk.mjs";');

  fs.writeFileSync(path.join(dir, 'sdk.mjs'), 'export const close = async () => {};\n');
  fs.writeFileSync(path.join(dir, 'lesson.mjs'), built);

  const child = spawn(process.execPath, [path.join(dir, 'lesson.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  t.teardown(() => clearTimeout(timer));

  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const code = await new Promise((resolve) => child.on('exit', resolve));
  clearTimeout(timer);

  t.is(code, 1, 'the run is not reported as a success');
  t.ok(err.includes('boom'), 'and says what went wrong');
});
