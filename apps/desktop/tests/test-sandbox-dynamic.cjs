'use strict';

// Dynamic allowlist tests: parent reads this JSON at spawn time to
// extend the static baseline. How new QVAC SDKs / models opt in
// without a code change.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadDynamicCapabilities,
  mergeCapabilities,
  getCapabilities,
} = require('../electron/sandbox/capabilities.cjs');
const { wrapSpawn, defaultDynamicPath } = require('../electron/sandbox/index.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dynamic-'));
const dynPath = path.join(tmp, 'allowlist.json');

const missing = loadDynamicCapabilities(path.join(tmp, 'nope.json'));
assert.equal(missing, null, 'missing file must return null');
console.log('[test-sandbox-dynamic] missing file returns null: PASS');

const fixture = {
  fs: { read: ['/opt/new-sdk/'], write: ['/opt/new-sdk/scratch/'] },
  exec: ['/usr/local/bin/new-cli'],
  env: { passThrough: ['NEW_SDK_TOKEN'], block: [] },
};
fs.writeFileSync(dynPath, JSON.stringify(fixture));
const parsed = loadDynamicCapabilities(dynPath);
assert.deepEqual(parsed, fixture, 'valid JSON must round-trip');
console.log('[test-sandbox-dynamic] valid JSON parsed: PASS');

const badPath = path.join(tmp, 'bad.json');
fs.writeFileSync(badPath, '{ not valid');
assert.throws(
  () => loadDynamicCapabilities(badPath),
  /invalid JSON/,
  'invalid JSON must throw',
);
console.log('[test-sandbox-dynamic] invalid JSON throws: PASS');

const base = getCapabilities('qvac');
const merged = mergeCapabilities(base, {
  fs: { read: ['/opt/new-sdk/'], write: ['/opt/new-sdk/scratch/'] },
  exec: ['/usr/local/bin/new-cli'],
});
assert.ok(merged.fs.read.includes('/opt/new-sdk/'), 'merged.fs.read must include the new entry');
assert.ok(merged.fs.write.includes('/opt/new-sdk/scratch/'), 'merged.fs.write must include the new entry');
assert.ok(merged.exec.includes('/usr/local/bin/new-cli'), 'merged.exec must include the new entry');
assert.ok(merged.exec.includes('ffmpeg'), 'merged.exec must still include ffmpeg from base');
assert.ok(merged.fs.write.includes('<%= tmpDir %>'), 'merged.fs.write must keep the base entry');
console.log('[test-sandbox-dynamic] merge unions arrays: PASS');

const result = wrapSpawn('/bin/echo', ['hi'], { dynamicPath: dynPath }, 'qvac');
assert.ok(Array.isArray(result.warnings), 'result.warnings must be an array');
assert.ok(typeof result.sandboxed === 'boolean', 'result.sandboxed must be a boolean');
console.log('[test-sandbox-dynamic] wrapSpawn accepts dynamicPath: PASS');

// Structural check: the path is outside the QVAC capability's
// write allowlist, so the child can't tamper with it.
const dp = defaultDynamicPath();
assert.ok(typeof dp === 'string' && dp.length > 0, 'defaultDynamicPath must return a string');
assert.ok(!dp.includes(`${path.sep}.qvac${path.sep}`) && !dp.includes(`${path.sep}.qvac`),
  'default dynamic path must NOT be under ~/.qvac (which the child can write to)');
console.log('[test-sandbox-dynamic] defaultDynamicPath is outside child-writable dir: PASS');
console.log('  path:', dp);

try { fs.unlinkSync(dynPath); } catch {}
try { fs.unlinkSync(badPath); } catch {}
try { fs.rmdirSync(tmp); } catch {}

console.log('[test-sandbox-dynamic] PASS');
