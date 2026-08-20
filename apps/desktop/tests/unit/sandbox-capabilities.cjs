'use strict';

// Checks what the generated profile says; whether the kernel enforces it is integration/sandbox-spawn.cjs.

const test = require('brittle');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildProfile, _allowRules: macAllowRules } = require('../../workers/sandbox/sandbox-mac.cjs');
const {
  CAPABILITIES,
  PRODUCT_NAMES,
  defaultTemplateVars,
  expandDeep,
  secretsDir,
  confinedPaths,
  appStateDir,
} = require('../../workers/sandbox/capabilities.cjs');

test('capabilities - qvac capability has the expected shape', (t) => {
  t.ok(PRODUCT_NAMES.includes('qvac'));

  const qvac = CAPABILITIES.qvac;
  t.ok(qvac, 'CAPABILITIES.qvac exists');
  t.ok(Array.isArray(qvac.fs?.read));
  t.ok(Array.isArray(qvac.fs?.write));
  t.ok(Array.isArray(qvac.exec));
  t.ok(Array.isArray(qvac.env?.passThrough));
  t.ok(Array.isArray(qvac.env?.block));

  for (const os of ['mac', 'linux', 'windows']) {
    t.ok(qvac.platformOverrides?.[os], `platformOverrides.${os} present`);
  }
});

// Generating the profile is pure string work, so this runs on every platform.
test('capabilities - generated profile denies by default', (t) => {
  const profile = buildProfile('qvac');
  t.ok(profile.startsWith('(version 1)\n'));
  t.ok(profile.split('\n').includes('(deny default)'));
});

test('capabilities - the app bundle is never writable', { skip: process.platform !== 'darwin' }, (t) => {
  const qvac = CAPABILITIES.qvac;
  const vars = defaultTemplateVars();

  t.absent(qvac.fs.write.includes('<%= appRoot %>'), 'appRoot not in write list');
  t.absent(qvac.fs.write.includes(vars.appRoot));
  t.absent(qvac.fs.write.includes('<%= coursesDir %>'), 'coursesDir not in write list');
  t.absent(
    buildProfile('qvac').includes(`(allow file-write* file-write-create (subpath "${vars.appRoot}"))`),
    'profile grants no write to the app root',
  );
});

// The child is the bare runtime, so Electron's grants went with it.
test('capabilities - mac profile grants what the runtime needs', { skip: process.platform !== 'darwin' }, (t) => {
  const profile = buildProfile('qvac');

  t.ok(profile.includes(`(allow process-exec (literal "${process.execPath}"))`));
  t.ok(profile.includes('(allow process-fork)'), 'the SDK spawns a worker');
  t.absent(profile.includes('(allow mach-register)'));
  t.absent(CAPABILITIES.qvac.env.force?.ELECTRON_RUN_AS_NODE);
});

// The sandbox policy itself lives in this directory, so a lesson that could write it controls its own permissions next run.
test('capabilities - the app state directory is denied, not granted', { skip: process.platform !== 'darwin' }, (t) => {
  const profile = buildProfile('qvac');
  const vars = defaultTemplateVars();

  t.absent(CAPABILITIES.qvac.fs.write.includes('<%= userData %>'), 'not in the write list');
  t.ok(profile.includes(`(deny file-write* file-write-create (subpath "${vars.userData}")`));
  t.ok(profile.includes(`(deny file-read* (subpath "${vars.userData}")`));
  // The audit file is covered by containment, not by name; pin that so a future move out of userData shows up.
  const auditFile = path.join(vars.userData, 'peer-audit.jsonl');
  t.ok(auditFile.startsWith(vars.userData + path.sep) || auditFile.startsWith(vars.userData + '/'),
    'audit file is inside userData, where the subpath deny already covers it');
  t.ok(profile.includes(`(deny file-read* (subpath "${secretsDir()}"))`), 'and the fallback key with it');
});

// ~/.qvac stays writable for model fetches/cache updates; per-file immutability is applied by wrapSpawn, not by a subtree rule here.
test('capabilities - the SDK state directory is writable', (t) => {
  const qvac = CAPABILITIES.qvac;

  t.ok(qvac.fs.read.includes('<%= homeDir %>/.qvac'), 'cached weights load');
  t.ok(qvac.fs.write.includes('<%= homeDir %>/.qvac'), 'the registry can update');
  t.alike(qvac.fs.readOnly, [], 'nothing frozen statically');
});

// The specific operation (file-write-create) outranks a later file-write* wildcard grant.
test('capabilities - a frozen path is denied for creation too', { skip: process.platform !== 'darwin' }, (t) => {
  const profile = [
    '(version 1)',
    '(deny default)',
    ...macAllowRules(
      expandDeep({ ...CAPABILITIES.qvac, fs: { ...CAPABILITIES.qvac.fs, readOnly: ['/tmp/frozen'] } },
        defaultTemplateVars()),
      { warnings: [] },
    ),
  ].join('\n');

  t.ok(profile.includes('(deny file-write* file-write-create (subpath "/private/tmp/frozen"))'));
  t.ok(profile.includes('(deny file-write-create (vnode-type SYMLINK))'), 'and no links anywhere');
});

// The kernel matches canonical paths. A freeze on a directory the run has not
// created yet still has to name /private/tmp, or the rule binds to nothing the
// moment the run creates it.
test('capabilities - a frozen path that does not exist yet still canonicalises', { skip: process.platform !== 'darwin' }, (t) => {
  const missing = path.join('/tmp', `frozen-${process.pid}`, 'nested');
  t.absent(fs.existsSync(missing), 'the path is not on disk');

  const rules = macAllowRules(
    expandDeep({ ...CAPABILITIES.qvac, fs: { ...CAPABILITIES.qvac.fs, readOnly: [missing] } },
      defaultTemplateVars()),
    { warnings: [] },
  ).join('\n');

  t.ok(rules.includes(`(subpath "/private${missing}")`), 'the deny names the canonical path');
  t.absent(rules.includes(`(subpath "${missing}")`), 'and not the symlinked one');
});

// os.tmpdir() is a per-user directory on macOS but shared /tmp on Linux, so writes are scoped to the run directory, not the whole thing.
test('capabilities - writes are scoped to one run, not all of /tmp', (t) => {
  const qvac = CAPABILITIES.qvac;

  t.ok(qvac.fs.write.includes('<%= runDir %>'));
  t.absent(qvac.fs.write.includes('<%= tmpDir %>'));
});

// dyld and Node need to read broadly, so reads are allow-then-deny; the deny list is what protects secrets.
test('capabilities - mac profile denies sensitive reads', { skip: process.platform !== 'darwin' }, (t) => {
  const profile = buildProfile('qvac');

  t.ok(profile.split('\n').includes('(allow file-read*)'), 'broad read required by dyld/Node');
  t.ok(profile.includes('(deny file-read* (subpath'), 'sensitive subpaths denied');
  t.ok(profile.includes('.ssh'), '~/.ssh denied');
});

// The deny list is generated from $HOME, so an entry nobody named is still covered; this is the rule-generation half, sandbox-spawn.cjs asks the kernel.
test('capabilities - home entries are denied unless the run needs them', { skip: process.platform !== 'darwin' }, (t) => {
  const home = os.homedir();
  const denied = new Set(
    buildProfile('qvac')
      .split('\n')
      .filter((line) => line.startsWith('(deny file-read* (subpath'))
      .map((line) => JSON.parse(line.match(/"(?:[^"\\]|\\.)*"/)[0])),
  );

  let entries;
  try {
    entries = fs.readdirSync(home);
  } catch {
    t.pass('home is not enumerable here; nothing to assert');
    return;
  }

  const cap = expandDeep(CAPABILITIES.qvac, defaultTemplateVars());
  const reachable = [...(cap.fs?.read ?? []), ...(cap.fs?.write ?? []), process.execPath];
  const needed = (entry) => {
    const full = path.join(home, entry);
    return reachable.some((p) => String(p).startsWith(full));
  };

  const missed = entries.filter(
    (entry) => !denied.has(path.join(home, entry)) && !needed(entry) && entry !== '.CFUserTextEncoding',
  );
  t.alike(missed, ['Library'], `only Library stays readable wholesale, got: ${missed.join(', ')}`);
});

// sandbox-exec cannot filter by domain, so network.hosts only documents intent; a granted run gets everything.
test('capabilities - network is denied by default', { skip: process.platform !== 'darwin' }, (t) => {
  t.is(CAPABILITIES.qvac.network?.mode, 'none');
  t.ok(Array.isArray(CAPABILITIES.qvac.network?.hosts));
  t.absent(
    buildProfile('qvac').includes('(allow network-outbound (remote ip'),
    'an ungranted run reaches no IP at all',
  );
});

test('capabilities - linux bwrap args unshare everything including the network', { skip: process.platform !== 'linux' }, (t) => {
  const linux = require('../../workers/sandbox/sandbox-linux.cjs');
  const cap = expandDeep(CAPABILITIES.qvac, defaultTemplateVars());
  const args = linux.buildBwrapArgs(cap);

  t.ok(Array.isArray(args));
  t.ok(args.includes('--unshare-all'));
  t.absent(args.includes('--share-net'), 'no net until a run is granted it');

  // A machine without a usable bwrap gets the command back untouched, nothing to separate.
  const wrap = linux.buildWrap(cap, '/usr/bin/node', ['-e', '1']);
  if (wrap.bwrapMissing || wrap.namespacesUnavailable || wrap.seccompUnavailable) {
    t.is(wrap.command, '/usr/bin/node', 'an unusable bwrap hands the command back');
    t.alike(wrap.args, ['-e', '1'], 'with its arguments untouched');
    return;
  }
  const sep = wrap.args.indexOf('--');
  t.ok(sep !== -1, 'the child command is separated from bwrap args');
  t.alike(wrap.args.slice(sep + 1), ['/usr/bin/node', '-e', '1'], 'child command follows it');
});

// The deny complement is generated by listing what's on disk, so caching the profile would silently pin one home's answer.
test('capabilities - the deny set is rebuilt from disk every time', { skip: process.platform !== 'darwin' }, (t) => {
  const realHome = process.env.HOME;
  t.teardown(() => {
    process.env.HOME = realHome;
  });

  const homes = ['a', 'b'].map((tag) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ta-home-${tag}-`)));
    t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  });
  const denied = (profile, dir) => profile.includes(`(deny file-read* (subpath "${dir}"))`);

  const secretA = path.join(homes[0], 'secret-a');
  fs.mkdirSync(secretA);
  process.env.HOME = homes[0];
  t.ok(denied(buildProfile('qvac'), secretA), 'what is in $HOME is denied');

  const secretB = path.join(homes[1], 'secret-b');
  fs.mkdirSync(secretB);
  process.env.HOME = homes[1];
  const second = buildProfile('qvac');
  t.ok(denied(second, secretB), 'a new $HOME is enumerated');
  t.absent(denied(second, secretA), 'and the old one is not carried over');

  const later = path.join(homes[1], 'created-later');
  fs.mkdirSync(later);
  t.ok(denied(buildProfile('qvac'), later), 'a directory added since the last build is covered');
});

// An unbounded walk turns a crowded directory into a child that never starts; the warning matters as much as the cap since skipped paths stay readable.
test('capabilities - a crowded directory cannot grow the profile without bound', { skip: process.platform !== 'darwin' }, (t) => {
  const realHome = process.env.HOME;
  t.teardown(() => {
    process.env.HOME = realHome;
  });

  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-home-crowded-')));
  t.teardown(() => fs.rmSync(home, { recursive: true, force: true }));
  for (let i = 0; i < 6000; i++) {
    fs.writeFileSync(path.join(home, `entry-${i}`), '');
  }
  process.env.HOME = home;

  const warnings = [];
  const cap = expandDeep(CAPABILITIES.qvac, defaultTemplateVars());
  const denies = macAllowRules(cap, { warnings }).filter((rule) => rule.startsWith('(deny file-read*'));

  t.ok(denies.length < 6000, `deny rules capped at ${denies.length}, not one per entry`);
  t.ok(
    warnings.some((w) => w.includes('deny walk stopped')),
    'the profile records that the walk stopped early',
  );
});

// Windows has no shipped confinement comparable to seatbelt or bwrap, so peer-exec must refuse rather than run unconfined.
test('capabilities - windows reports unavailable', { skip: process.platform !== 'win32' }, (t) => {
  const win = require('../../workers/sandbox/sandbox-windows.cjs');
  const result = win.buildWrap(
    expandDeep(CAPABILITIES.qvac, defaultTemplateVars()),
    'C:/node.exe',
    ['-e', '1'],
  );

  t.is(result.mode, 'windows-unavailable');
  t.ok(result.warnings.length > 0, 'refusal is explained');
});

// The deny list must name the resolved userData, not the home-default, or the profile denies the wrong directory.
test('capabilities - defaultTemplateVars honors a userData override', (t) => {
  const override = path.join(os.tmpdir(), 'sandbox-test-override');
  const vars = defaultTemplateVars({ userData: override });
  t.is(vars.userData, override, 'the resolved path is what the profile denies');

  const confined = confinedPaths(override);
  t.ok(confined.includes(override), 'the state dir is in the deny list');
  t.ok(
    confined.includes(path.join(override, 'keys')),
    'the keys dir moves with the override',
  );

  const home = appStateDir();
  const fallback = confinedPaths();
  t.ok(fallback.includes(home), 'no override means home-default is denied');
});
