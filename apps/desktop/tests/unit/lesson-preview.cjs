'use strict';

// Inline preview allowlist + MIME lookup. The renderer-side SavedPreview
// component reuses the same extension set, so a single test here is enough
// for both ends.

const test = require('brittle');
const {
  mimeFor,
  canPreviewFile,
  extOf,
  PREVIEWABLE_EXTS,
  MAX_READ_SAVED_BYTES,
} = require('../../shared/lesson-preview.cjs');

test('lesson-preview - mimeFor maps each preview extension', (t) => {
  t.is(mimeFor('/Users/x/Photos/cat.png'), 'image/png');
  t.is(mimeFor('/Users/x/Photos/CAT.PNG'), 'image/png', 'extension match is case-insensitive');
  t.is(mimeFor('/Users/x/Photos/cat.jpg'), 'image/jpeg');
  t.is(mimeFor('/Users/x/Photos/cat.jpeg'), 'image/jpeg');
  t.is(mimeFor('/Users/x/Photos/cat.webp'), 'image/webp');
  t.is(mimeFor('/Users/x/Photos/cat.gif'), 'image/gif');
  t.is(mimeFor('/Users/x/Movies/clip.mp4'), 'video/mp4');
  t.is(mimeFor('/Users/x/Movies/clip.webm'), 'video/webm');
  t.is(mimeFor('/Users/x/Movies/clip.mov'), 'video/quicktime');
  t.is(mimeFor('/Users/x/Movies/clip.avi'), 'video/x-msvideo');
  t.is(mimeFor('/Users/x/Audio/voice.mp3'), 'audio/mpeg');
  t.is(mimeFor('/Users/x/Audio/voice.wav'), 'audio/wav');
  // Bundles + assets:
  t.is(mimeFor('/web/static/index.html'), 'text/html; charset=utf-8');
  t.is(mimeFor('/web/static/app.js'), 'text/javascript; charset=utf-8');
  t.is(mimeFor('/web/static/app.mjs'), 'text/javascript; charset=utf-8');
  t.is(mimeFor('/web/static/style.css'), 'text/css; charset=utf-8');
  t.is(mimeFor('/web/static/data.json'), 'application/json; charset=utf-8');
  t.is(mimeFor('/web/static/logo.svg'), 'image/svg+xml');
  t.is(mimeFor('/web/static/font.woff2'), 'font/woff2');
});

test('lesson-preview - mimeFor falls back to octet-stream for unknown types', (t) => {
  t.is(mimeFor('/Users/x/Notes/readme.txt'), 'application/octet-stream');
  t.is(mimeFor('/Users/x/Notes/data.bin'), 'application/octet-stream');
  t.is(mimeFor(''), 'application/octet-stream');
});

test('lesson-preview - canPreviewFile returns true for the previewable set', (t) => {
  for (const ext of PREVIEWABLE_EXTS) {
    const path = `/Users/x/output/avatar.${ext}`;
    t.is(canPreviewFile(path), true, `${ext} should be previewable`);
    t.is(canPreviewFile(path.toUpperCase()), true, `${ext.toUpperCase()} (case-insensitive)`);
  }
});

test('lesson-preview - canPreviewFile rejects non-previewable types', (t) => {
  t.is(canPreviewFile('/Users/x/Notes/readme.txt'), false);
  t.is(canPreviewFile('/Users/x/data/config.json'), false);
  t.is(canPreviewFile('/Users/x/bundle/index.js'), false);
  t.is(canPreviewFile(''), false);
});

test('lesson-preview - extOf strips the lowercased extension', (t) => {
  t.is(extOf('/a/b/CAT.PNG'), 'png');
  t.is(extOf('no-extension'), '');
  t.is(extOf('.hidden'), '');
  t.is(extOf(''), '');
});

test('lesson-preview - MAX_READ_SAVED_BYTES is sized for a generated MP4', (t) => {
  t.ok(typeof MAX_READ_SAVED_BYTES === 'number', 'is a number');
  t.ok(MAX_READ_SAVED_BYTES >= 16 * 1024 * 1024, 'room for a typical MP4 clip');
  t.ok(MAX_READ_SAVED_BYTES <= 128 * 1024 * 1024, 'capped under IPC payload budget');
});
