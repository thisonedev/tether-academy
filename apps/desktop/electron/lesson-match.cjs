'use strict';

// Code this device already ships is not worth a model's opinion, so a peer
// sending a file identical to one on disk here skips the review. The lookup
// reads this host's own courses copy, never the sender's claim about it.

const fs = require('node:fs');
const path = require('node:path');

// Shared with the editor's own answer-match fast path, so a run it calls an
// exact match is the run this host skips.
const { normalizeLessonCode } = require('@academy/validation/lesson-code');

const LESSON_FILE = /\.m?ts$/;

function readLessonSources(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // A packaged build without the examples tree reviews everything instead.
    return [];
  }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : readLessonSources(full);
    if (!LESSON_FILE.test(entry.name)) return [];
    try {
      return [fs.readFileSync(full, 'utf8')];
    } catch {
      return [];
    }
  });
}

// Read once per process. A lesson edited on disk mid-session falls through to
// the review, which is the safe direction for this to be wrong in.
let known = null;

function knownLessonCode() {
  if (known) return known;
  // Same resolver the sandbox and exec-host use, so the path stays in step.
  const { coursesDir } = require('../workers/sandbox/capabilities.cjs').defaultTemplateVars();
  known = new Set(readLessonSources(path.join(coursesDir, 'examples')).map(normalizeLessonCode));
  known.delete('');
  return known;
}

function isKnownLessonCode(source) {
  const normalized = normalizeLessonCode(source);
  return normalized.length > 0 && knownLessonCode().has(normalized);
}

module.exports = {
  isKnownLessonCode,
  knownLessonCount: () => knownLessonCode().size,
  _resetForTests: () => { known = null; },
};
