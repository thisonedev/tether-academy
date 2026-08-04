'use strict';

// "Paired device" mode end to end: a real lesson, wrapped by buildLesson() as
// the app wraps it, run on a remote peer. The part unique here is whether
// `import from "@qvac/sdk"` resolves inside the sandbox, and whether the child gets the `process` the lesson writes to.

const test = require('brittle');
const path = require('node:path');

const { pairForExec, runExec } = require('../helpers/index.cjs');
const { buildLesson } = require('../../electron/runner-process.cjs');

const COURSES_DIR = path.resolve(__dirname, '../../../../packages/courses');

const LESSON_SOURCE = [
  'import { loadModel, close } from "@qvac/sdk";',
  '',
  'async function main() {',
  '  process.stdout.write("peer-runner:hello\\n");',
  '  process.stdout.write("peer-runner:platform=" + process.platform + "\\n");',
  '  process.stdout.write("peer-runner:loadModel=" + (typeof loadModel) + "\\n");',
  '  process.stdout.write("peer-runner:close=" + (typeof close) + "\\n");',
  '}',
  '',
  'main().catch((err) => { console.error("peer-runner:error", err); process.exit(1); });',
].join('\n');

// Without the SDK teardown, a lesson that loaded a model would leave the runtime open and the process would never exit.
test('runner-peer - buildLesson wraps the lesson with SDK teardown', (t) => {
  const wrapped = buildLesson({ source: LESSON_SOURCE, cwd: COURSES_DIR });

  t.ok(wrapped.includes('close'), 'close is imported');
  t.ok(wrapped.includes('.finally'), 'teardown is hooked onto main()');
});

// The lesson mentions neither, so both must come from the wrapper.
test('runner-peer - the Bare build supplies process and the SDK plugins', (t) => {
  const wrapped = buildLesson({ source: LESSON_SOURCE, cwd: COURSES_DIR, runtime: 'bare' });

  t.ok(/^import process from ".*bare-process/m.test(wrapped), 'process is bound');
  t.ok(wrapped.includes('__academyPlugins('), 'plugins are registered before the first SDK call');
  t.absent(wrapped.includes('"node:'), 'no node: specifier survives into a Bare build');
});

test('runner-peer - a wrapped lesson runs on a remote peer with the QVAC SDK available', async (t) => {
  const { guest, discoveryKey } = await pairForExec(t, 'runner-peer');

  const result = await runExec(
    guest,
    {
      peerId: discoveryKey,
      code: buildLesson({ source: LESSON_SOURCE, cwd: COURSES_DIR, runtime: 'bare' }),
      mode: 'file',
      cwd: COURSES_DIR,
      fileName: 'snippet.mjs',
    },
    30_000,
  );

  t.ok(result.stdout.includes('peer-runner:hello'), 'lesson ran');
  t.ok(result.stdout.includes('peer-runner:platform='), 'ran on the remote side');
  t.ok(
    result.stdout.includes('peer-runner:loadModel=function'),
    'the @qvac/sdk import resolved inside the sandbox',
  );
  t.ok(result.stdout.includes('peer-runner:close=function'), 'close resolved too');
  t.is(result.code, 0);
});
