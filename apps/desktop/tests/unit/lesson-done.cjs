'use strict';

// A model mid-render is silent for minutes at a time. Closing on that silence
// killed the video lessons before they wrote a frame.

const test = require('brittle');
const { LESSON_DONE_MARKER, takeLessonDone } = require('../../shared/lesson-done.cjs');

test('lesson-done - the marker never reaches the reader', (t) => {
  const chunk = `some output\n${LESSON_DONE_MARKER}`;
  const { text, done } = takeLessonDone(chunk);
  t.is(done, true, 'the host sees the lesson finished');
  t.absent(text.includes('academy:lesson-done'), 'and the marker is stripped out');
  t.ok(text.includes('some output'), 'leaving what the lesson printed');
});

test('lesson-done - ordinary output is not mistaken for the marker', (t) => {
  const { text, done } = takeLessonDone('Generated 1 video\n');
  t.is(done, false);
  t.is(text, 'Generated 1 video\n');
});
