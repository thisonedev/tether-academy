'use strict';

// The same confinement questions as sandbox-spawn.cjs, asked through the whole
// pairing + exec path. Skipped on Windows, where peer-exec is refused.

const test = require('brittle');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const { bareImports, bareRequires, pairForExec, runExec, tmpDir } = require('../helpers/index.cjs');

const BARE_FS = bareRequires('fs', 'path', 'child_process', 'process');

const skip = process.platform === 'win32';
const projectDir = path.resolve(__dirname, '../..');
const sshPath = path.join(os.homedir(), '.ssh', 'id_rsa');

// Reports "blocked: <errno>" or "leaked", never throws, so a denial and a crash cannot be mistaken for each other.
const attempt = (body) =>
  `try { ${body} } catch (e) { process.stdout.write('blocked: ' + e.code + '\\n'); }`;

const readFile = (file) =>
  BARE_FS
  + attempt(
    `const p = fs.readFileSync(${JSON.stringify(file)}, 'utf8');`
      + `process.stdout.write('read ' + p.length + ' bytes\\n');`,
  );

// Asserts the fields every exec must record, whatever it did.
function assertSandboxedAudit(t, entries, label) {
  t.ok(entries.length > 0, `${label}: sandbox decision recorded`);
  for (const entry of entries) {
    t.is(entry.sandboxed, true, `${label}: ran sandboxed`);
    t.is(typeof entry.sandboxMode, 'string', `${label}: names its mode`);
    t.ok(Array.isArray(entry.warnings), `${label}: carries warnings[]`);
  }
}

test('sandbox-enforcement - peer-exec cannot read the host user\'s ssh keys', { skip }, async (t) => {
  const { guest, discoveryKey } = await pairForExec(t, 'sbint-ssh');

  const result = await runExec(guest, { peerId: discoveryKey, code: readFile(sshPath) });

  t.ok(result.stdout.startsWith('blocked'), `expected a denial, got: ${result.stdout.trim()}`);
});

// The generated deny complement used to stop at $HOME. Each target below is world-readable with no profile applied, so a denial can only come from the profile.
test('sandbox-enforcement - read confinement reaches past $HOME', { skip: skip || process.platform !== 'darwin' }, async (t) => {
  const { guest, discoveryKey } = await pairForExec(t, 'sbint-outside-home');

  const neighbour = path.join('/tmp', `sb-neighbour-${Date.now()}-${process.pid}.txt`);
  fs.writeFileSync(neighbour, 'another process wrote this');
  t.teardown(() => fs.rmSync(neighbour, { force: true }));

  for (const [label, target] of [
    ['a system credential store', '/etc/ssh/ssh_config'],
    ['a sibling account', '/Users/Shared'],
    ["another process's scratch", neighbour],
  ]) {
    const result = await runExec(guest, { peerId: discoveryKey, code: readFile(target) });
    t.ok(result.stdout.startsWith('blocked'), `${label}: expected a denial, got ${result.stdout.trim()}`);
  }
});

test('sandbox-enforcement - peer-exec cannot write outside the scratch dir', { skip }, async (t) => {
  const { guest, discoveryKey } = await pairForExec(t, 'sbint-write');
  // /usr is not in the write allowlist; os.tmpdir() is, deliberately, so it
  // would prove nothing.
  const evilFile = path.join('/usr', `sb-evil-${Date.now()}-${process.pid}.txt`);
  t.teardown(() => fs.rmSync(evilFile, { force: true }));

  const result = await runExec(guest, {
    peerId: discoveryKey,
    code: BARE_FS + attempt(
      `fs.writeFileSync(${JSON.stringify(evilFile)}, 'x');`
        + `process.stdout.write('leaked\\n');`,
    ),
  });

  t.ok(result.stdout.startsWith('blocked'), `expected a denial, got: ${result.stdout.trim()}`);
});

test('sandbox-enforcement - peer-exec can still read the app bundle', { skip }, async (t) => {
  const { guest, discoveryKey } = await pairForExec(t, 'sbint-read');

  const result = await runExec(guest, {
    peerId: discoveryKey,
    code: readFile(path.join(projectDir, 'package.json')),
  });

  t.ok(result.stdout.startsWith('read '), `expected a successful read, got: ${result.stdout.trim()}`);
});

// npm needs its cache writable, and npx needs to execute what it extracted there; this asks the kernel whether the two are split by subtree.
test('sandbox-enforcement - peer-exec cannot execute what it writes to the npm cache', { skip }, async (t) => {
  const { guest, discoveryKey } = await pairForExec(t, 'sbint-npm-cache');
  const cacheDir = path.join(fs.realpathSync(os.tmpdir()), 'academy-npm-cache');
  const drop = path.join(cacheDir, `sb-evil-${Date.now()}-${process.pid}.sh`);
  t.teardown(() => fs.rmSync(drop, { force: true }));

  const result = await runExec(guest, {
    peerId: discoveryKey,
    code: [
      BARE_FS,
      `const { execFileSync } = child_process;`,
      attempt(
        `fs.writeFileSync(${JSON.stringify(drop)}, '#!/bin/sh\\necho PWNED\\n', { mode: 0o755 });`
          + `process.stdout.write('wrote\\n');`,
      ),
      attempt(
        `execFileSync(${JSON.stringify(drop)});`
          + `process.stdout.write('executed\\n');`,
      ),
      attempt(
        `fs.writeFileSync(path.join(${JSON.stringify(cacheDir)}, '_npx', 'sb-evil.sh'), 'x');`
          + `process.stdout.write('wrote _npx\\n');`,
      ),
    ].join('\n'),
  });

  const out = result.stdout;
  t.absent(out.includes('executed'), `the cache must not be executable; got: ${out.trim()}`);
  t.absent(out.includes('wrote _npx'), `the exec subtree must be frozen; got: ${out.trim()}`);
});

test('sandbox-enforcement - every run is audited as sandboxed', { skip }, async (t) => {
  const { host, guest, discoveryKey } = await pairForExec(t, 'sbint-audit');
  const before = host.getAudit().length;

  for (const code of [readFile(sshPath), readFile(path.join(projectDir, 'package.json'))]) {
    await runExec(guest, { peerId: discoveryKey, code });
  }

  assertSandboxedAudit(
    t,
    host.getAudit().slice(before).filter((e) => e.type === 'peer:exec:sandboxed'),
    'each run',
  );
});

// Sandbox mode is chosen by inspecting the code for QVAC usage; that detection must not be fooled by a comment.
test('sandbox-enforcement - a comment mentioning @qvac/sdk does not weaken the sandbox', { skip }, async (t) => {
  const { host, guest, discoveryKey } = await pairForExec(t, 'sbint-decoy');
  const before = host.getAudit().length;

  const result = await runExec(guest, {
    peerId: discoveryKey,
    code: ['// @qvac/sdk', '// qvac/sdk/index', readFile(sshPath)].join('\n'),
  });

  t.ok(result.stdout.startsWith('blocked'), 'ssh read still denied');

  const entry = host.getAudit().slice(before).find((e) => e.type === 'peer:exec:sandboxed');
  t.is(entry?.sandboxed, true, 'still sandboxed');
  t.not(entry?.sandboxMode, 'qvac-env-only', 'a comment did not unlock env-only mode');
});

// The QVAC SDK spawns bare-runtime as a nested child; this must work under the kernel sandbox without falling back to env-only mode.
test('sandbox-enforcement - QVAC SDK can spawn a nested bare runtime while confined', { skip }, async (t) => {
  const { host, guest, discoveryKey } = await pairForExec(t, 'sbint-qvac');
  const before = host.getAudit().length;

  const qvacSdkPath = require.resolve('@qvac/sdk');
  const bareSpawnPath = createRequire(qvacSdkPath).resolve('bare-runtime/spawn');
  const bareChild = path.join(tmpDir(t, 'bare-tiny'), 'child.mjs');
  fs.writeFileSync(bareChild, 'console.log("bare-child-ok")\n');

  const result = await runExec(
    guest,
    {
      peerId: discoveryKey,
      // File mode, because this snippet is an ES module and bare evaluates an
      // inline one as CommonJS.
      mode: 'file',
      code: [
        bareImports('process'),
        `import { close } from ${JSON.stringify(qvacSdkPath)};`,
        `import spawn from ${JSON.stringify(bareSpawnPath)};`,
        `process.stdout.write("qvac-hello\\n");`,
        `const p = spawn("bare", { args: [${JSON.stringify(bareChild)}], stdio: ["ignore", "pipe", "pipe"] });`,
        `await new Promise((resolve, reject) => {`,
        `  let out = "";`,
        `  p.stdout.on("data", (d) => { out += d; });`,
        `  p.stderr.on("data", (d) => process.stderr.write(d));`,
        `  p.on("error", reject);`,
        `  p.on("exit", (code) => {`,
        `    process.stdout.write("bare-spawn-exit " + code + " out=" + out.trim() + "\\n");`,
        `    if (code === 0 && out.includes("bare-child-ok")) resolve();`,
        `    else reject(new Error("bare child failed code=" + code + " out=" + out));`,
        `  });`,
        `});`,
        `await close().catch(() => {});`,
        `process.exit(0);`,
      ].join('\n'),
    },
    20_000,
  );

  t.ok(result.stdout.includes('qvac-hello'), 'the SDK loaded');
  t.ok(result.stdout.includes('bare-child-ok'), 'the nested bare runtime ran');
  t.is(result.code, 0);

  const entry = host.getAudit().slice(before).find((e) => e.type === 'peer:exec:sandboxed');
  t.is(entry?.sandboxed, true, 'stayed sandboxed');
  t.not(entry?.sandboxMode, 'qvac-env-only', 'nested bare did not force env-only mode');
});
