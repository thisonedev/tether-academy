'use strict';

// Recording hardware is off in the base capability and turned on for one run
// via wrapSpawn's `grants`; a denied macOS capture returns silence rather than an error, so the default matters.

const test = require('brittle');
const fs = require('fs');

const sandbox = require('../../workers/sandbox/index.cjs');
const { CAPABILITIES } = require('../../workers/sandbox/capabilities.cjs');
const { buildBwrapArgs } = require('../../workers/sandbox/sandbox-linux.cjs');

const wrap = (opts) => sandbox.wrapSpawn(process.execPath, ['-e', '0'], opts, 'qvac');

test('device-grants - the base capability grants no recording hardware', (t) => {
  t.is(CAPABILITIES.qvac.device?.microphone, false);
  t.is(CAPABILITIES.qvac.device?.camera, false);
});

test('device-grants - an unknown grant is rejected, not ignored', (t) => {
  t.exception(() => wrap({ grants: ['gps'] }), /unknown run grant/);
});

test('device-grants - outbound network is a grant like any other', { skip: process.platform !== 'darwin' }, (t) => {
  const read = (r) => fs.readFileSync(r.profilePath, 'utf8');

  const denied = read(wrap({}));
  t.absent(denied.includes('(allow network-outbound (remote ip'), 'no IP without a grant');
  t.ok(denied.includes('(allow network-outbound (remote unix-socket))'), 'the QVAC worker socket survives');

  const loopback = read(wrap({ grants: ['network-loopback'] }));
  // Only `*` and `localhost` are accepted as the host part; a literal address makes sandbox-exec reject the profile outright.
  t.ok(loopback.includes('(allow network-outbound (remote ip "localhost:*"))'));
  t.absent(/remote ip "(?:127\.0\.0\.1|::1)/.test(loopback), 'no literal address');
  t.absent(loopback.includes('(remote ip "*:*")'), 'loopback is not egress');

  t.ok(read(wrap({ grants: ['network'] })).includes('(allow network-outbound (remote ip "*:*"))'));
});

test('device-grants - macOS emits the rule only when granted', { skip: process.platform !== 'darwin' }, (t) => {
  const denied = fs.readFileSync(wrap({}).profilePath, 'utf8');
  t.absent(denied.includes('(allow device-microphone)'), 'no mic without a grant');

  const granted = wrap({ grants: ['microphone'] });
  const profile = fs.readFileSync(granted.profilePath, 'utf8');
  t.ok(profile.includes('(allow device-microphone)'));
  t.absent(profile.includes('(allow device-camera)'), 'grants do not bleed into each other');
  t.ok(
    granted.warnings.some((w) => /microphone access granted/.test(w)),
    'the grant is visible to the audit trail',
  );
});

// bwrap has no address filter, so a loopback ask there comes out as full egress; the caller compares the two and refuses the run.
test('network-scope - Linux cannot narrow a run to loopback', (t) => {
  const { enforcedNetworkScope } = sandbox;

  t.is(enforcedNetworkScope('localhost', 'darwin'), 'localhost');
  t.is(enforcedNetworkScope('localhost', 'linux'), 'all');
  t.is(enforcedNetworkScope('all', 'linux'), 'all');
  t.is(enforcedNetworkScope('none', 'linux'), 'none', 'unshare-all leaves no interface');
  t.is(enforcedNetworkScope(undefined, 'darwin'), 'none');
});

test('network-scope - wrapSpawn reports what the run will get', (t) => {
  t.is(wrap({}).networkScope, 'none');
  t.is(wrap({ grants: ['network'] }).networkScope, 'all');
  t.is(
    wrap({ grants: ['network-loopback'] }).networkScope,
    process.platform === 'darwin' ? 'localhost' : 'all',
  );
});

test('device-grants - Linux binds the capture device only when granted', (t) => {
  const denied = buildBwrapArgs({ ...CAPABILITIES.qvac }, { warnings: [] });
  t.absent(denied.includes('/dev/snd'), 'no capture device in the namespace by default');

  const warnings = [];
  const granted = buildBwrapArgs(
    { ...CAPABILITIES.qvac, device: { microphone: true } },
    { warnings },
  );
  t.ok(granted.includes('/dev/snd'));
  t.ok(warnings.some((w) => /microphone access granted/.test(w)));
});

// A caller cannot skip assertRunAsNode.
test('run-grants - a node child cannot be built without RUN_AS_NODE', (t) => {
  const { assertRunAsNode } = sandbox;

  t.exception(() => assertRunAsNode('node', {}), /ELECTRON_RUN_AS_NODE/);
  t.exception(() => assertRunAsNode('node', { ELECTRON_RUN_AS_NODE: '0' }), /ELECTRON_RUN_AS_NODE/);
  t.execution(() => assertRunAsNode('node', { ELECTRON_RUN_AS_NODE: '1' }));
  t.execution(() => assertRunAsNode('bare', {}), 'bare is unaffected');
});

test('run-grants - wrapSpawn forces RUN_AS_NODE on the node runtime', (t) => {
  t.is(wrap({ runtime: 'node' }).env.ELECTRON_RUN_AS_NODE, '1');
  t.absent(wrap({}).env.ELECTRON_RUN_AS_NODE, 'and never sets it for bare');
});

// Electron registers a Mach port on startup; bare never asks.
test('run-grants - mach-register is only for the node runtime', { skip: process.platform !== 'darwin' }, (t) => {
  const read = (r) => fs.readFileSync(r.profilePath, 'utf8');

  t.ok(read(wrap({ runtime: 'node' })).includes('(allow mach-register)'));
  t.absent(read(wrap({})).includes('(allow mach-register)'));
});
