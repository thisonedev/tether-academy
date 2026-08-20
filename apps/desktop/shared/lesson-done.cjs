// What a lesson prints when its own entry call settles, before the SDK
// teardown that can outlive it. A model load says nothing for minutes, so
// silence alone reads the same as a finished run.
'use strict';

const LESSON_DONE_MARKER = '[academy:lesson-done]\n';

/** Strips the marker from a chunk, and says whether it was there. */
function takeLessonDone(text) {
  if (!text.includes(LESSON_DONE_MARKER.trim())) return { text, done: false };
  return { text: text.split(LESSON_DONE_MARKER.trim()).join('').replace(/\n{3,}/g, '\n\n'), done: true };
}

module.exports = { LESSON_DONE_MARKER, takeLessonDone };
