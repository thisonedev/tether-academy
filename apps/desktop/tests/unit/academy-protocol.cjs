'use strict';

// Pin the navigation hardening's URL comparison and the resolveStaticPath
// behaviour that the academy:// protocol handler relies on.
//
// The hazard this guards is silent: Node's URL serialises every non-special
// scheme to origin 'null', so an origin comparison would accept academy://evil/
// alongside academy://app/. The test pins the fix.

const test = require('brittle');
const path = require('path');
const fs = require('fs');
const os = require('os');

const main = fs.readFileSync(
  path.resolve(__dirname, '../../electron/main.js'),
  'utf8',
);

function simulateWillNavigate(url, allowedOrigins) {
  let allowed = false;
  try {
    const parsed = new URL(url);
    allowed = allowedOrigins.some((origin) => {
      try {
        const allow = new URL(origin);
        if (allow.protocol === 'academy:') {
          return parsed.protocol === 'academy:' && parsed.host === allow.host;
        }
        return parsed.origin === allow.origin;
      } catch {
        return false;
      }
    });
  } catch {
    allowed = false;
  }
  return allowed;
}

test('academy protocol - academy://app/ is allowed when academy://app is in the allowlist', (t) => {
  t.is(
    simulateWillNavigate('academy://app/', ['academy://app/']),
    true,
  );
});

test('academy protocol - academy://evil/ is refused when academy://app is in the allowlist', (t) => {
  t.is(
    simulateWillNavigate('academy://evil/', ['academy://app/']),
    false,
  );
});

test('academy protocol - origin comparison would accept academy://evil/ (the trap)', (t) => {
  // The implementation fix exists because Node's URL returns 'null' for both,
  // so a naive origin comparison would let the wrong host through.
  const a = new URL('academy://app/').origin;
  const b = new URL('academy://evil/').origin;
  t.is(a, b, 'Node serialises both custom-scheme URLs to the same origin');
  t.is(a, 'null', 'both origins are the opaque string "null"');
});

test('academy protocol - academy://anything is refused when allowlist is empty', (t) => {
  t.is(simulateWillNavigate('academy://app/', []), false, 'no allowlist, no entry');
});

test('academy protocol - http(s) dev URLs compare on origin', (t) => {
  t.is(
    simulateWillNavigate('http://localhost:3000/page', ['http://localhost:3000']),
    true,
    'http origin equality still works',
  );
  t.is(
    simulateWillNavigate('http://localhost:9999/page', ['http://localhost:3000']),
    false,
    'different port is refused',
  );
  t.is(
    simulateWillNavigate('http://evil.example/', ['http://localhost:3000']),
    false,
    'different host is refused',
  );
});

test('academy protocol - main.js implements the fix', (t) => {
  // Belt for the live wiring: the implementation has to branch on academy:
  // explicitly and not rely on parsed.origin.
  t.ok(
    /parsed\.protocol === 'academy:' && parsed\.host === allow\.host/.test(main),
    'main.js compares academy scheme + host explicitly',
  );
});

test('academy protocol - resolveStaticPath rejects escapes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-proto-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html></html>');
  try {
    // Re-evaluate the function locally: requiring main.js needs Electron.
    const resolveStaticPath = (pathname, r) => {
      let p = decodeURIComponent(pathname || '/');
      const basePrefix = '/tether-academy';
      if (p === basePrefix || p.startsWith(`${basePrefix}/`)) {
        p = p.slice(basePrefix.length) || '/';
      }
      const rootWithSep = r.endsWith(path.sep) ? r : r + path.sep;
      const abs = path.resolve(r, '.' + p);
      if (abs !== r && !abs.startsWith(rootWithSep)) return null;
      return abs;
    };

    t.ok(resolveStaticPath('/', root) === root);
    t.ok(
      resolveStaticPath('/index.html', root) === path.join(root, 'index.html'),
    );
    t.is(resolveStaticPath('/../../../etc/passwd', root), null);
    t.is(
      resolveStaticPath('/tether-academy/index.html', root),
      path.join(root, 'index.html'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('academy protocol - main.js no longer requires node:http', (t) => {
  t.absent(
    /require\('node:http'\)|require\('http'\)/.test(main),
  );
});