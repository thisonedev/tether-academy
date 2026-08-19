// What a lesson prints when its own entry call settles, before the SDK
// teardown that can keep the process alive afterwards. The host waits for this
// because a model load or a video render says nothing for minutes, and silence
// on its own reads the same as a finished run.
'use strict';

const LESSON_DONE_MARKER = '[academy:lesson-done]\n';

/** Strips the marker from a chunk, and says whether it was there. */
function takeLessonDone(text) {
  if (!text.includes(LESSON_DONE_MARKER.trim())) return { text, done: false };
  return { text: text.split(LESSON_DONE_MARKER.trim()).join('').replace(/\n{3,}/g, '\n\n'), done: true };
}

module.exports = { LESSON_DONE_MARKER, takeLessonDone };
