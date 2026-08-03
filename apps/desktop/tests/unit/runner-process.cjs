'use strict';

// Containment of the buildLesson fixture-path rewrite. The local runner
// executes the rewritten source without a sandbox, so a lesson that
// escapes the courses directory can read whatever the user account can
// see.

const test = require('brittle');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildLesson } = require('../../electron/runner-process.cjs');

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
  // path.join would collapse `..` outside coursesDir; the rewrite
  // refuses instead, so a hostile lesson cannot read ~/.ssh or similar.
  t.exception(() => {
    buildLesson({
      source: "import x from 'examples/../../../../etc/passwd';\n",
      cwd: COURSES,
    });
  }, /refused path outside coursesDir/);
});

// An earlier parser sliced the wrong characters when the handler body ran on
// to a second line and rebuilt the call from the pieces. This one moves the
// text as it stands, so the handler has to come through byte for byte.
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
