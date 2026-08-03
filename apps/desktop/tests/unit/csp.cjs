'use strict';

// Pins the renderer Content-Security-Policy. The same directives are emitted
// in two places: the Electron main-process header and the web export's
// <meta>. Both must name only the same origins and the same source-list, or
// the renderer is parsing the wrong one. A remote origin in script-src is the
// failure mode this guards: a CDN compromise, a TLS intercept, or a pinned-
// range mistake would otherwise run code in the same origin that holds
// window.academy.

const test = require('brittle');
const fs = require('node:fs');
const path = require('node:path');

const { CSP_DIRECTIVES, CONTENT_SECURITY_POLICY, SECURITY_HEADERS } = require('../../electron/security-headers.cjs');

const WEB_LAYOUT = path.resolve(__dirname, '../../../web/src/app/layout.tsx');
const META_ONLY_POLICY = CSP_DIRECTIVES.join('; ');

test('csp - script-src does not name any remote origin', (t) => {
  const csp = CONTENT_SECURITY_POLICY;
  // Every directive with a source list. The regex stops at the first ';' or
  // end of string, which is what the CSP grammar asks for.
  const directives = {};
  for (const d of csp.split(';').map((s) => s.trim()).filter(Boolean)) {
    const idx = d.indexOf(' ');
    if (idx === -1) {
      directives[d] = '';
      continue;
    }
    directives[d.slice(0, idx)] = d.slice(idx + 1);
  }
  for (const [name, value] of Object.entries(directives)) {
    // frame-ancestors does not load code, but the same rule still applies:
    // every named origin is an attack surface.
    const hosts = value.match(/https?:\/\/[^\s]+/g) ?? [];
    t.alike(hosts, [], `${name} names no remote origin`);
  }
});

test('csp - the electron header and the web <meta> agree on the policy', (t) => {
  // The Electron header is CONTENT_SECURITY_POLICY; the web <meta> is every
  // directive except frame-ancestors, which a <meta> tag ignores anyway.
  const source = fs.readFileSync(WEB_LAYOUT, 'utf8');
  // Extract just the string-literal entries from the contentSecurityPolicy
  // array. Comments between them are fine; the policy is the concatenation.
  // Each entry is a quoted directive like "default-src 'self'".
  const directives = [];
  const re = /"((?:default|script|style|img|font|worker|connect|object|base|form)[^"]*)"/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    directives.push(m[1]);
  }
  // The web layout must include every directive the electron module exports
  // (frame-ancestors excepted).
  for (const directive of CSP_DIRECTIVES) {
    t.ok(directives.includes(directive), `${directive} is in both policies`);
  }
  t.ok(
    !source.includes('https://cdn.jsdelivr.net'),
    'web layout does not name jsdelivr anywhere',
  );
});

test('csp - SECURITY_HEADERS has the four static headers a renderer needs', (t) => {
  t.ok(SECURITY_HEADERS['Content-Security-Policy'], 'CSP is set');
  t.is(SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff', 'no MIME sniffing');
  t.is(SECURITY_HEADERS['X-Frame-Options'], 'DENY', 'no framing');
  t.is(SECURITY_HEADERS['Referrer-Policy'], 'no-referrer', 'no referrer leak');
});
