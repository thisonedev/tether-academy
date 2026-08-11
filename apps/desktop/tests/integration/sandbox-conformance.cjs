'use strict';

// Runs the capability-to-enforcement matrix against a real kernel; every other
// sandbox test checks what the profile says, this one checks what the OS does
// with it, row by row. The first run found a profile macOS had been rejecting
// outright, which every string-level test had passed. Skipped on Windows
// (peer-exec refused) and on Linux without a working bwrap, where a
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
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));

  const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS);
  t.teardown(() => clearTimeout(timer));
  await new Promise((resolve) => child.on('exit', resolve));
  clearTimeout(timer);
  return { out: out.trim(), err: err.trim() };
}

for (const row of CONFORMANCE) {
  const expected = row.expect[platform];

  test(`conformance - ${row.id}: ${row.claim}`, { skip: unavailable }, async (t) => {
    if (expected === 'not-claimed') {
      t.pass(`${platform} does not claim this`);
      t.comment(row.note ?? 'no note recorded');
      return;
    }

    // run-tests.mjs only keeps lines matching /^\s*not ok/ in its CI summary;
    // a raw newline in a failure message would drop everything after it.
    const { out, err } = await runRow(t, row);
    const oneLine = (s) => s.replace(/\s*\n\s*/g, ' | ');
    if (expected === 'denied') {
      t.ok(out.startsWith('blocked'), `expected a denial, got: out=${oneLine(out) || '(none)'} err=${oneLine(err) || '(none)'}`);
    } else {
      t.absent(out.startsWith('blocked'), `expected it to be permitted, got: out=${oneLine(out)} err=${oneLine(err)}`);
      if (row.note) t.comment(row.note);
    }
  });
}

// A row whose platform column says nothing is a claim nobody wrote down.
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
