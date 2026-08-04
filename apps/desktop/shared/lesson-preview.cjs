'use strict';

// Inline preview support for files a lesson saves via `[saved] <absPath>`.
// `mimeFor` is a fall-through lookup; `canPreviewFile` is the renderer-side
// allowlist matching the same set so a file that won't preview doesn't even
// trigger an IPC. Both are intentionally permissive rather than secure:
// main's `academy:read-saved` handler confines reads to the lesson home, and
// `academy:` is not registered for arbitrary paths.

const MIME_BY_EXT = Object.freeze({
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  woff2: 'font/woff2',
});

const PREVIEWABLE_EXTS = Object.freeze(new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'mp4',
  'webm',
  'mov',
  'avi',
  'mp3',
  'wav',
]));

function mimeFor(p) {
  const ext = extOf(p);
  if (!ext) return 'application/octet-stream';
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// Returns the lowercased extension or ''. `.hidden` (a dotfile with no
// preceding basename) and `no-extension` (no dot at all) both return ''.
function extOf(p) {
  const m = String(p || '').toLowerCase().match(/[^./]+\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function canPreviewFile(p) {
  const ext = extOf(p);
  return !!ext && PREVIEWABLE_EXTS.has(ext);
}

module.exports = {
  mimeFor,
  canPreviewFile,
  extOf,
  PREVIEWABLE_EXTS,
  /** Sized for a generated MP4 clip; bigger files return null from `readSaved`. */
  MAX_READ_SAVED_BYTES: 64 * 1024 * 1024,
};
