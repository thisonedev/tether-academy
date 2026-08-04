'use strict';

// Real-spawn enforcement: everything else checks what the profile says, this
// checks what the kernel does. Skipped on Windows, where peer-exec is refused.

const test = require('brittle');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { wrapSpawn } = require('../../workers/sandbox/index.cjs');
const { CAPABILITIES } = require('../../workers/sandbox/capabilities.cjs');

const skip = process.platform === 'win32';
const project = path.resolve(__dirname, '../..');
const CHILD_TIMEOUT_MS = 12_000;

// Runs `code` inside the sandbox and resolves its stdout; the snippet always exits 0 and reports its outcome on stdout.
async function runSandboxed(t, code, grants = []) {
  const wrap = wrapSpawn(process.execPath, ['-e', code], { cwd: project, grants }, CAPABILITIES.qvac);
  if (wrap.profilePath) {
    t.teardown(() => fs.rmSync(wrap.profilePath, { force: true }));
  }

  const child = spawn(wrap.command, wrap.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...wrap.env },
    cwd: project,
  });

  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));

  const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
  t.teardown(() => clearTimeout(timer));

  const code_ = await new Promise((resolve) => child.on('exit', resolve));
  clearTimeout(timer);
  return { out: out.trim(), err: err.trim(), code: code_ };
}

// Reports "blocked: <errno>" or "leaked", never throws.
const attempt = (body) =>
  `try { ${body} } catch (e) { process.stdout.write('blocked: ' + e.code + '\\n'); process.exit(0); }`;

test('sandbox-spawn - cannot read ~/.ssh private keys', { skip }, async (t) => {
  const sshPath = path.join(os.homedir(), '.ssh', 'id_rsa');
  const { out } = await runSandboxed(
    t,
    attempt(
      `const p = require('node:fs').readFileSync(${JSON.stringify(sshPath)}, 'utf8');` +
        `process.stdout.write('leaked ' + p.length + ' bytes\\n'); process.exit(0);`,
    ),
  );

  t.ok(out.startsWith('blocked'), `expected a denial, got: ${out}`);
});

// The deny-list is generated from $HOME rather than a fixed set of names, so an ordinary home directory nobody named must still be out of reach.
test('sandbox-spawn - cannot read home directories the run has no claim on', { skip }, async (t) => {
  const probes = ['Desktop', 'Downloads', 'Movies', 'Pictures'].filter((name) =>
    fs.existsSync(path.join(os.homedir(), name)),
  );
  t.ok(probes.length > 0, 'this home has directories to check');

  const { out } = await runSandboxed(
    t,
    attempt(
      `const fs = require('node:fs');`
        + `const out = {};`
        + `for (const p of ${JSON.stringify(probes)}) {`
        + `  try { fs.readdirSync(${JSON.stringify(os.homedir())} + '/' + p); out[p] = 'READABLE'; }`
        + `  catch (e) { out[p] = e.code; }`
        + `}`
        + `process.stdout.write(JSON.stringify(out) + '\\n'); process.exit(0);`,
    ),
  );

  t.absent(out.includes('READABLE'), `every probed directory must be denied, got: ${out}`);
});

test('sandbox-spawn - cannot write outside the scratch dir', { skip }, async (t) => {
  // /tmp would not prove anything, since os.tmpdir() is allowlisted on purpose.
  const { out } = await runSandboxed(
    t,
    attempt(
      `require('node:fs').writeFileSync('/usr/sb-evil.txt', 'x');` +
        `process.stdout.write('leaked\\n'); process.exit(0);`,
    ),
  );

  t.ok(out.startsWith('blocked'), `expected a denial, got: ${out}`);
});

test('sandbox-spawn - can still read the app bundle it runs from', { skip }, async (t) => {
  const { out } = await runSandboxed(
    t,
    attempt(
      `const p = require('node:fs').readFileSync(${JSON.stringify(path.join(project, 'package.json'))}, 'utf8');` +
        `process.stdout.write('ok ' + p.length + '\\n'); process.exit(0);`,
    ),
  );

  t.ok(out.startsWith('ok '), `read of the app bundle must succeed, got: ${out}`);
});

const reachExample =
  `const https = require('node:https');` +
  `const req = https.get('https://example.com', (r) => { process.stdout.write('reached ' + r.statusCode + '\\n'); process.exit(0); });` +
  `req.on('error', (e) => { process.stdout.write('blocked: ' + e.code + '\\n'); process.exit(0); });` +
  `req.setTimeout(6000, () => { process.stdout.write('timeout\\n'); process.exit(0); });`;

test('sandbox-spawn - an ungranted run cannot reach a host', { skip }, async (t) => {
  const { out } = await runSandboxed(t, reachExample);
  t.ok(out.startsWith('blocked'), `expected a denial, got: ${out}`);
});

// Known gap, asserted rather than left as a comment: sandbox-exec cannot filter by domain, so a granted run reaches every host.
test('sandbox-spawn - a granted run reaches any host', { skip }, async (t) => {
  const { out } = await runSandboxed(t, reachExample, ['network']);

  t.ok(/^(reached|timeout)/.test(out), `expected the grant to open egress, got: ${out}`);
  t.comment(`network outcome: ${out} (per-domain filtering is not available under sandbox-exec)`);
});
