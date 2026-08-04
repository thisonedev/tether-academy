'use strict';

// The dynamic allowlist: a JSON file the parent reads at spawn time to extend
// the static baseline, letting a new QVAC SDK or model opt into extra paths without a code change.

const test = require('brittle');
const fs = require('node:fs');
const path = require('node:path');

const {
  loadDynamicCapabilities,
  mergeCapabilities,
  getCapabilities,
} = require('../../workers/sandbox/capabilities.cjs');
const {
  wrapSpawn,
  makeRunDir,
  defaultDynamicPath,
  legacyDynamicPath,
  loadAllowlists,
  COURSE_ALLOWLIST_PATH,
} = require('../../workers/sandbox/index.cjs');
const { buildProfile } = require('../../workers/sandbox/sandbox-mac.cjs');
const { tmpDir } = require('../helpers/index.cjs');

const FIXTURE = {
  fs: { read: ['/opt/new-sdk/'], write: ['/opt/new-sdk/scratch/'] },
  exec: ['/usr/local/bin/new-cli'],
  env: { passThrough: ['NEW_SDK_TOKEN'], block: [] },
};

test('dynamic-allowlist - a missing file is not an error', (t) => {
  t.is(loadDynamicCapabilities(path.join(tmpDir(t, 'sb-dynamic'), 'nope.json')), null);
});

test('dynamic-allowlist - valid JSON round-trips', (t) => {
  const file = path.join(tmpDir(t, 'sb-dynamic'), 'allowlist.json');
  fs.writeFileSync(file, JSON.stringify(FIXTURE));

  t.alike(loadDynamicCapabilities(file), FIXTURE);
});

// Must throw rather than silently fall back to the baseline; a corrupt allowlist that quietly disappears is a confusing way to lose access.
test('dynamic-allowlist - invalid JSON throws', (t) => {
  const file = path.join(tmpDir(t, 'sb-dynamic'), 'bad.json');
  fs.writeFileSync(file, '{ not valid');

  t.exception(() => loadDynamicCapabilities(file), /invalid JSON/);
});

test('dynamic-allowlist - merging unions with the baseline, never replaces it', (t) => {
  const merged = mergeCapabilities(getCapabilities('qvac'), {
    fs: { read: ['/opt/new-sdk/'], write: ['/opt/new-sdk/scratch/'] },
    exec: ['/usr/local/bin/new-cli'],
  });

  t.ok(merged.fs.read.includes('/opt/new-sdk/'), 'new read entry present');
  t.ok(merged.fs.write.includes('/opt/new-sdk/scratch/'), 'new write entry present');
  t.ok(merged.exec.includes('/usr/local/bin/new-cli'), 'new exec entry present');

  t.ok(merged.exec.includes('ffmpeg'), 'baseline exec entry survives');
  t.ok(merged.fs.write.includes('<%= runDir %>'), 'baseline write entry survives');
});

test('dynamic-allowlist - wrapSpawn accepts a dynamicPath', (t) => {
  const file = path.join(tmpDir(t, 'sb-dynamic'), 'allowlist.json');
  fs.writeFileSync(file, JSON.stringify(FIXTURE));

  const result = wrapSpawn('/bin/echo', ['hi'], { dynamicPath: file }, 'qvac');
  t.ok(Array.isArray(result.warnings));
  t.is(typeof result.sandboxed, 'boolean');
});

test('dynamic-allowlist - the course allowlist ships and loads', (t) => {
  t.ok(COURSE_ALLOWLIST_PATH.endsWith('course-allowlist.json'));

  const allow = loadAllowlists({});
  t.ok(Array.isArray(allow.merged?.exec));
  t.ok(
    allow.merged.exec.includes('npx') || allow.merged.exec.includes('node'),
    'lessons can spawn node/npx',
  );
});

/** Write subpaths a generated macOS profile grants. */
function writeGrants(profile) {
  return [...profile.matchAll(/\(allow file-write\*[^(]*\(subpath "([^"]+)"\)\)/g)].map((m) => m[1]);
}

// A stale comment above defaultDynamicPath() claimed the path was unwritable; it was not, and one file write bought a
// permanent sandbox escape. This asserts against a real generated profile instead.
test('dynamic-allowlist - no write rule covers the allowlist path', (t) => {
  const dp = defaultDynamicPath();
  t.ok(typeof dp === 'string' && dp.length > 0);
  t.absent(dp.includes(`${path.sep}.qvac`), 'not under ~/.qvac, which the child can write');

  if (process.platform !== 'darwin') return;
  for (const granted of writeGrants(buildProfile('qvac'))) {
    t.absent(
      dp === granted || dp.startsWith(granted + path.sep),
      `write grant on ${granted} does not reach the allowlist`,
    );
  }
});

// An allowlist that grants write on its own directory makes the next run's policy whatever the last run wrote.
test('dynamic-allowlist - an allowlist cannot grant write on itself', (t) => {
  const file = path.join(tmpDir(t, 'sb-dynamic'), 'allowlist.json');
  const stateDir = path.dirname(path.dirname(defaultDynamicPath()));
  fs.writeFileSync(file, JSON.stringify({ fs: { read: [stateDir], write: [stateDir] } }), { mode: 0o600 });
  // A real run directory: the test helper's is too long to hold a unix socket.
  const runDir = makeRunDir();
  t.teardown(() => fs.rmSync(runDir, { recursive: true, force: true }));

  const result = wrapSpawn('/bin/echo', ['hi'], { dynamicPath: file, runDir }, 'qvac');
  t.ok(
    result.warnings.some((w) => w.includes('dropped write grant')),
    'the grant is dropped, and says so',
  );

  if (process.platform !== 'darwin') return;
  const profile = fs.readFileSync(result.profilePath, 'utf8');
  for (const granted of writeGrants(profile)) {
    t.absent(granted === stateDir || granted.startsWith(stateDir + path.sep));
  }
  t.ok(
    profile.includes(`(deny file-write* file-write-create (subpath "${stateDir}"))`),
    'and denied outright, creation included',
  );
  t.ok(profile.includes(`(deny file-read* (subpath "${stateDir}"))`), 'reads too');
});

// An allowlist a second account can edit says nothing about the owner.
test('dynamic-allowlist - a group- or world-writable allowlist is refused', { skip: process.platform === 'win32' }, (t) => {
  const file = path.join(tmpDir(t, 'sb-dynamic'), 'loose.json');
  fs.writeFileSync(file, JSON.stringify(FIXTURE));
  fs.chmodSync(file, 0o666); // umask makes the create mode unreliable

  t.exception(() => loadDynamicCapabilities(file), /writable beyond its owner/);
});

// A file at the old location may be the sandboxed child's own work.
test('dynamic-allowlist - the pre-confinement path is not the default', (t) => {
  t.not(defaultDynamicPath(), legacyDynamicPath());
  t.is(path.basename(path.dirname(defaultDynamicPath())), 'policy');
});
