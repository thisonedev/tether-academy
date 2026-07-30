'use strict';

// Cross-platform: generates the QVAC profile and asserts the right
// rules are present. Same module on every platform; assertions vary.

const assert = require('node:assert/strict');
const { buildProfile } = require('../electron/sandbox/sandbox-mac.cjs');
const {
  CAPABILITIES,
  PRODUCT_NAMES,
  defaultTemplateVars,
} = require('../electron/sandbox/capabilities.cjs');

const platform = process.platform;
const profile = buildProfile('qvac');
const lines = profile.split('\n');

console.log('[test-sandbox-capabilities] platform:', platform);
console.log('[test-sandbox-capabilities] profile size:', profile.length, 'bytes,', lines.length, 'lines');

assert.ok(profile.startsWith('(version 1)\n'), 'profile must start with (version 1)');
assert.ok(lines.includes('(deny default)'), 'profile must include (deny default)');

assert.ok(PRODUCT_NAMES.includes('qvac'), 'PRODUCT_NAMES must include qvac');

const qvac = CAPABILITIES.qvac;
assert.ok(qvac, 'CAPABILITIES.qvac must exist');
assert.ok(Array.isArray(qvac.fs?.read), 'qvac.fs.read must be an array');
assert.ok(Array.isArray(qvac.fs?.write), 'qvac.fs.write must be an array');
assert.ok(Array.isArray(qvac.exec), 'qvac.exec must be an array');
assert.ok(qvac.env && Array.isArray(qvac.env.passThrough), 'qvac.env.passThrough must be an array');
assert.ok(qvac.env && Array.isArray(qvac.env.block), 'qvac.env.block must be an array');
assert.ok(qvac.platformOverrides && qvac.platformOverrides.mac, 'qvac.platformOverrides.mac must exist');
assert.ok(qvac.platformOverrides && qvac.platformOverrides.linux, 'qvac.platformOverrides.linux must exist');
assert.ok(qvac.platformOverrides && qvac.platformOverrides.windows, 'qvac.platformOverrides.windows must exist');

if (platform === 'darwin') {
  const projectDir = defaultTemplateVars().appRoot;
  assert.ok(
    profile.includes(`(subpath "${projectDir}")`),
    'profile must include project dir as a write subpath: ' + projectDir,
  );
  const userData = defaultTemplateVars().userData;
  assert.ok(
    profile.includes(`(subpath "${userData}")`),
    'profile must include userData write subpath: ' + userData,
  );
  assert.ok(
    profile.includes(`(allow process-exec (literal "${process.execPath}"))`),
    'profile must allow process-exec of process.execPath',
  );
  assert.ok(
    profile.includes('(allow network-outbound (remote ip "*:*"))'),
    'profile must allow outbound network (coarse)',
  );
  console.log('[test-sandbox-capabilities] mac assertions: PASS');
} else if (platform === 'linux') {
  // eslint-disable-next-line global-require
  const linux = require('../electron/sandbox/sandbox-linux.cjs');
  const args = linux.buildBwrapArgs(require('../electron/sandbox/capabilities.cjs').expandDeep(CAPABILITIES.qvac, defaultTemplateVars()));
  assert.ok(Array.isArray(args), 'linux bwrap args must be an array');
  assert.ok(args.includes('--unshare-all'), 'bwrap args must include --unshare-all');
  assert.ok(args.includes('--share-net'), 'bwrap args must include --share-net');
  assert.ok(args.includes('--'), 'bwrap args must end with -- separator');
  console.log('[test-sandbox-capabilities] linux assertions: PASS (bwrap args ok)');
} else if (platform === 'win32') {
  // eslint-disable-next-line global-require
  const win = require('../electron/sandbox/sandbox-windows.cjs');
  const result = win.buildWrap(
    require('../electron/sandbox/capabilities.cjs').expandDeep(CAPABILITIES.qvac, defaultTemplateVars()),
    'C:/node.exe',
    ['-e', '1'],
  );
  assert.equal(result.mode, 'passthrough', 'windows best-effort must be passthrough');
  assert.ok(result.warnings.length > 0, 'windows must emit at least one warning');
  console.log('[test-sandbox-capabilities] windows assertions: PASS (best-effort)');
} else {
  console.log('[test-sandbox-capabilities] platform not in {darwin, linux, win32}; basic shape only');
}

console.log('[test-sandbox-capabilities] PASS');
