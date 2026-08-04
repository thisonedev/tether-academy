'use strict';

// Bounds on a deeplink the host accepts; rejected at parse time rather than left to the renderer.

const test = require('brittle');
const fs = require('node:fs');

// parsePairUrl is not exported; read the source and lift just that function plus the
// protocol constant, since the function depends on the outer-scope `deeplinkProtocol`.
const src = fs.readFileSync(
  require('node:path').join(__dirname, '../../electron/main.js'),
  'utf8',
);
const fnMatch = src.match(/function parsePairUrl\([\s\S]+?\n\}/);
if (!fnMatch) {
  throw new Error('parsePairUrl not found in main.js');
}
const pkg = JSON.parse(
  fs.readFileSync(
    require('node:path').join(__dirname, '../../package.json'),
    'utf8',
  ),
);
const name = pkg.productName || pkg.name || 'tether-academy';
const deeplinkProtocol = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
const parsePairUrl = new Function(
  'deeplinkProtocol',
  `${fnMatch[0]}\nreturn parsePairUrl;`,
)(deeplinkProtocol);

test('parsePairUrl - rejects an oversized URL', (t) => {
  const long = `${deeplinkProtocol}://pair?i=` + 'A'.repeat(5000);
  t.is(parsePairUrl(long), null);
});

test('parsePairUrl - rejects a query with control characters', (t) => {
  t.is(parsePairUrl(`${deeplinkProtocol}://pair?i=ok&x=%01`), null);
});

test('parsePairUrl - accepts a well-formed pair URL', (t) => {
  const result = parsePairUrl(`${deeplinkProtocol}://pair?i=INVID&h=HOSTID`);
  t.is(result.invite, 'INVID');
  t.is(result.hostIdentity, 'HOSTID');
});

test('parsePairUrl - rejects a non-pair deeplink', (t) => {
  t.is(parsePairUrl(`${deeplinkProtocol}://other?i=INVID`), null);
});
