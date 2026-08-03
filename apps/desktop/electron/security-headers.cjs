// Single source of truth for the renderer's Content-Security-Policy. Both the
// Electron main-process header and the web export's <meta> read from this
// module so the two policies cannot drift. The values are intentionally
// explicit: no remote origins in script-src, because the IPC-bearing renderer
// is the trust boundary, and no origin that has not been bundled into the app
// itself. 'unsafe-eval' is here because the AMD loader's language workers
// evaluate what they load, and 'unsafe-inline' is here because the static
// export has no server to mint nonces for the inline bootstrap Next emits.
//
// frame-ancestors is only honoured as a real header, so the Electron main
// process appends it. The web export's <meta> ignores that directive.
'use strict';

const CSP_DIRECTIVES = Object.freeze([
  "default-src 'self'",
  // Monaco's AMD loader is served from /monaco/vs, copied at build time. No
  // remote origin, so a CDN compromise, a TLS intercept, or a pinned-range
  // mistake cannot run code in the same origin that holds window.academy.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
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
