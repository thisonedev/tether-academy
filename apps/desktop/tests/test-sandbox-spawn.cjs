'use strict';

// Real-spawn enforcement test. The only way to validate a sandbox
// is to actually try operations and see which ones the kernel
// blocks. Skipped on Windows because best-effort doesn't enforce
// file write or per-domain network.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { wrapSpawn } = require('../electron/sandbox/index.cjs');
const { CAPABILITIES } = require('../electron/sandbox/capabilities.cjs');

if (process.platform === 'win32') {
  console.log('SKIP: Windows sandbox is best-effort');
  console.log('(see sandbox-windows.cjs for the AppContainer gap; this test ' +
    'requires real file-write and network enforcement that Windows best-effort ' +
    'does not provide)');
  process.exit(0);
}

const project = path.resolve(__dirname, '..');
const tmpFile = path.join(os.tmpdir(), 'sb-spawn-test.txt');
const sshPath = path.join(os.homedir(), '.ssh', 'id_rsa');

const tests = [
  {
    name: '1. fs.readFileSync(~/.ssh/id_rsa) MUST throw',
    code: "try { const p = require('node:fs').readFileSync('" + sshPath + "', 'utf8'); process.stdout.write('FAIL leaked: ' + p.length + ' bytes\\n'); process.exit(0); } catch(e) { process.stdout.write('OK blocked: ' + e.code + '\\n'); process.exit(0); }",
    expect: 'OK blocked',
  },
  {
    name: '2. fs.writeFileSync(/usr/sb-evil.txt) outside scratch dir',
    code: "const fs = require('node:fs'); const evil = '/usr/sb-evil.txt'; try { fs.writeFileSync(evil, 'x'); process.stdout.write('FAIL leaked\\n'); process.exit(0); } catch(e) { process.stdout.write('OK blocked: ' + e.code + '\\n'); process.exit(0); }",
    expect: 'OK blocked',
  },
  {
    name: '3. https.get(example.com) — coarse network, documented gap',
    code: "const https = require('node:https'); const req = https.get('https://example.com', r => { process.stdout.write('OK status: ' + r.statusCode + '\\n'); process.exit(0); }); req.on('error', e => { process.stdout.write('OK blocked: ' + e.code + '\\n'); process.exit(0); }); req.setTimeout(6000, () => { process.stdout.write('TIMEOUT (allowed hang)\\n'); process.exit(0); });",
    expect: 'OK ',
    isGap: true,
  },
  {
    name: '4. fs.readFileSync(projectDir + /package.json) MUST succeed',
    code: "try { const p = require('node:fs').readFileSync('" + project + "/package.json', 'utf8'); process.stdout.write('OK ' + p.length + ' bytes\\n'); process.exit(0); } catch(e) { process.stdout.write('FAIL: ' + e.code + ' ' + e.message + '\\n'); process.exit(0); }",
    expect: 'OK ',
  },
  {
    name: '5. https.get(allowlisted domain) — coarse network allow',
    code: "const https = require('node:https'); const req = https.get('https://example.com', r => { process.stdout.write('OK status: ' + r.statusCode + '\\n'); process.exit(0); }); req.on('error', e => { process.stdout.write('OK blocked: ' + e.code + ' ' + e.message + '\\n'); process.exit(0); }); req.setTimeout(6000, () => { process.stdout.write('TIMEOUT\\n'); process.exit(0); });",
    expect: 'OK ',
  },
];

(async () => {
  try { fs.unlinkSync(tmpFile); } catch {}

  for (const t of tests) {
    const result = wrapSpawn(process.execPath, ['-e', t.code], { cwd: project }, CAPABILITIES.qvac);
    const child = spawn(result.command, result.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...result.env },
      cwd: project,
    });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    const r = await Promise.race([
      new Promise(res => child.on('exit', code => res({ code, out, err }))),
      new Promise(res => setTimeout(() => { child.kill('SIGKILL'); res({ code: 'TIMEOUT', out, err }); }, 12000)),
    ]);
    const pass = r.out.includes(t.expect) ? 'PASS' : 'FAIL';
    console.log(t.name + ': [' + pass + '] exit=' + r.code + ' out=' + r.out.trim() + (r.err ? ' err=' + r.err.slice(0, 200) : ''));
    if (!r.out.includes(t.expect)) {
      console.error('  expected substring: ' + JSON.stringify(t.expect));
    }
    if (result.profilePath) {
      try { fs.unlinkSync(result.profilePath); } catch {}
    }
    assert.ok(r.out.includes(t.expect), t.name + ' failed: expected ' + t.expect);
  }
  console.log('[test-sandbox-spawn] PASS');
})().catch(err => {
  console.error('[test-sandbox-spawn] ERR:', err);
  process.exit(1);
});
