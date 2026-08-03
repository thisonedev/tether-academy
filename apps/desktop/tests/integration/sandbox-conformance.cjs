'use strict';

// Runs the capability-to-enforcement matrix against a real kernel. Every other
// sandbox test checks what the profile says; this one checks what the OS does
// with it, row by row. The first run of it found a profile macOS had been
// rejecting outright, which every string-level test had passed.
//
// Skipped on Windows, where peer-exec is refused and there is nothing to
// verify. On Linux without a working bwrap the whole file skips, because a
// passthrough wrap would report every row as leaked and say nothing useful.

const test = require('brittle');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { wrapSpawn, makeRunDir } = require('../../workers/sandbox/index.cjs');
const { CAPABILITIES } = require('../../workers/sandbox/capabilities.cjs');
const { CONFORMANCE } = require('../helpers/conformance.cjs');

const platform = process.platform;
const project = path.resolve(__dirname, '../..');
const CHILD_TIMEOUT_MS = 12_000;

function sandboxUnavailable() {
  if (platform === 'win32') return 'peer-exec is refused on Windows';
  const probe = wrapSpawn(process.execPath, ['-e', '0'], {}, CAPABILITIES.qvac);
  if (probe.profilePath) fs.rmSync(probe.profilePath, { force: true });
  return probe.sandboxed ? null : `no usable sandbox (mode=${probe.mode})`;
}

const unavailable = sandboxUnavailable();

async function runRow(t, row) {
  const runDir = makeRunDir();
  t.teardown(() => fs.rmSync(runDir, { recursive: true, force: true }));

  const wrap = wrapSpawn(
    process.execPath,
    ['-e', row.code({ runDir })],
    { cwd: project, grants: row.grants, runDir },
    CAPABILITIES.qvac,
  );
  if (wrap.profilePath) t.teardown(() => fs.rmSync(wrap.profilePath, { force: true }));

  const stdio = ['ignore', 'pipe', 'pipe'];
  let seccompFd = null;
  if (wrap.seccompFilter) {
    const { openSeccompFd } = require('../../workers/sandbox/sandbox-linux.cjs');
    seccompFd = openSeccompFd(wrap.seccompFilter);
    stdio.push(seccompFd);
  }

  let child;
  try {
    child = spawn(wrap.command, wrap.args, {
      stdio,
      env: { ...process.env, ...wrap.env },
      cwd: project,
    });
  } finally {
    if (seccompFd !== null) fs.closeSync(seccompFd);
  }

  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', () => {});

  const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
  t.teardown(() => clearTimeout(timer));
  await new Promise((resolve) => child.on('exit', resolve));
  clearTimeout(timer);
  return out.trim();
}

for (const row of CONFORMANCE) {
  const expected = row.expect[platform];

  test(`conformance - ${row.id}: ${row.claim}`, { skip: unavailable }, async (t) => {
    if (expected === 'not-claimed') {
      t.pass(`${platform} does not claim this`);
      t.comment(row.note ?? 'no note recorded');
      return;
    }

    const out = await runRow(t, row);
    if (expected === 'denied') {
      t.ok(out.startsWith('blocked'), `expected a denial, got: ${out || '(no output)'}`);
    } else {
      t.absent(out.startsWith('blocked'), `expected it to be permitted, got: ${out}`);
      if (row.note) t.comment(row.note);
    }
  });
}

// A row whose platform column says nothing is a claim nobody wrote down, which
// is the state this matrix exists to end.
test('conformance - every row states an outcome for every platform', (t) => {
  const outcomes = ['denied', 'allowed', 'not-claimed'];
  for (const row of CONFORMANCE) {
    for (const os of ['darwin', 'linux']) {
      t.ok(outcomes.includes(row.expect[os]), `${row.id} on ${os}: ${row.expect[os]}`);
    }
    if (Object.values(row.expect).includes('not-claimed')) {
      t.ok(row.note, `${row.id} explains what refuses the run instead`);
    }
  }
});
