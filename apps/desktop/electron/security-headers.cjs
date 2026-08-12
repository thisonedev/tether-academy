// Single source of truth for the renderer's Content-Security-Policy: both the
// Electron main-process header and the web export's <meta> read from this
// module so the two policies cannot drift.
//
// frame-ancestors is only honoured as a real header, so the Electron main
// process appends it; the web export's <meta> ignores that directive.
'use strict';

const CSP_DIRECTIVES = Object.freeze([
  "default-src 'self'",
  // Monaco's AMD loader is served locally from /monaco/vs; no remote script origin.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
]);

const CONTENT_SECURITY_POLICY = [...CSP_DIRECTIVES, "frame-ancestors 'none'"].join('; ');

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
});

module.exports = {
  CSP_DIRECTIVES,
  CONTENT_SECURITY_POLICY,
  SECURITY_HEADERS,
};
