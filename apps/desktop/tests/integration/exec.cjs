'use strict';

// Peer-exec: a paired guest asks the host to run code and gets stdout, stderr
// and the exit status back. Covers the run itself and the audit the host keeps
// of it.

const test = require('brittle');

const { bareImports, bareRequires, pairForExec, runExec } = require('../helpers/index.cjs');

// Inline snippets are CommonJS on Bare, file mode is an ES module. See helpers.
const PROC = bareRequires('process');
const PROC_ESM = bareImports('process');

// run-tests.mjs only keeps lines matching /^\s*not ok/ in its CI summary;
// a raw newline in a failure message would drop everything after it.
const oneLine = (s) => s.replace(/\s*\n\s*/g, ' | ');

// The host reports the stages it crosses on stderr, so what the lesson itself
// wrote is whatever is left once those are removed.
const lessonStderr = (s) =>
  s
    .split('\n')
    .filter((line) => !/^\s*[→✓]/.test(line))
    .join('\n')
    .trim();

test('exec - guest code runs on the host and stdout streams back', async (t) => {
  const { guest, discoveryKey } = await pairForExec(t, 'exec-stdout');

  const result = await runExec(guest, {
    peerId: discoveryKey,
    code: PROC
      + 'process.stdout.write("hi from host\\n");'
      + 'process.stdout.write("platform: " + process.platform + "\\n");'
      + 'process.exit(0);',
  });

  const detail = oneLine(`code=${result.code} stdout=${result.stdout} stderr=${result.stderr}`);
  t.ok(result.stdout.includes('hi from host'), `expected the greeting; ${detail}`);
  t.ok(result.stdout.includes('platform:'), `code really ran on the remote side; ${detail}`);
  t.is(result.code, 0, detail);
  t.is(lessonStderr(result.stderr), '', `a clean run produces no stderr of its own; ${detail}`);
});

test('exec - stderr and a non-zero exit code propagate', async (t) => {
  const { guest, discoveryKey } = await pairForExec(t, 'exec-stderr');

  const result = await runExec(guest, {
    peerId: discoveryKey,
    code: PROC + 'process.stderr.write("boom\\n"); process.exit(7);',
  });

  const detail = oneLine(`code=${result.code} stdout=${result.stdout} stderr=${result.stderr}`);
  t.is(result.code, 7, `exit code survives the round trip; ${detail}`);
  t.ok(result.stderr.includes('boom'), detail);
});

// File mode writes the snippet to a real .mts file so lessons can use imports and get sensible stack traces.
test('exec - file mode runs a real script with argv passed through', async (t) => {
  const { guest, discoveryKey } = await pairForExec(t, 'exec-file');

  const result = await runExec(guest, {
    peerId: discoveryKey,
    mode: 'file',
    argv: ['--first', 'second'],
    code: [
      PROC_ESM,
      'const greeting = "file mode hi";',
      'const n = 41 + 1;',
      'process.stdout.write(greeting + " n=" + n + "\\n");',
      'process.stdout.write("argv=" + JSON.stringify(process.argv) + "\\n");',
      'process.exit(0);',
    ].join('\n'),
  });

  t.ok(result.stdout.includes('file mode hi'), 'script ran');
  t.ok(result.stdout.includes('n=42'), 'multi-line code survived');
  t.ok(result.stdout.includes('.mts'), 'the script path is in argv');
  t.ok(result.stdout.includes('"--first"'), 'argv reached the script');
  t.ok(result.stdout.includes('"second"'));
  t.is(result.code, 0);
});

test('exec - an unknown mode is rejected before anything is sent', async (t) => {
  const { guest, discoveryKey } = await pairForExec(t, 'exec-badmode');

  t.exception(
    () => guest.exec({ peerId: discoveryKey, code: 'x', mode: 'wat' }),
    /mode must be 'inline' or 'file'/,
  );
});

// SIGKILL escalation for children that ignore SIGTERM is exec-cancel.cjs.
test('exec - cancelExec kills a running child', async (t) => {
  const { guest, discoveryKey } = await pairForExec(t, 'exec-cancel');

  const result = await runExec(guest, {
    peerId: discoveryKey,
    code: PROC + 'setInterval(() => process.stdout.write("tick\\n"), 50);',
    onStdout: (stdout) => {
      if (stdout.length > 30) guest.cancelExec(discoveryKey);
    },
  });

  t.ok(result.stdout.includes('tick'), 'child produced output before the cancel');
  t.ok(result.signal === 'SIGTERM' || result.code !== 0, 'child was killed, not left running');
});

test('exec - cancelExec on an idle peer reports that there was nothing to cancel', async (t) => {
  const { guest, discoveryKey } = await pairForExec(t, 'exec-cancel-idle');

  t.is(guest.cancelExec(discoveryKey), false);
});

test('exec - the host audits every run, including the sandbox decision', async (t) => {
  const { host, guest, discoveryKey } = await pairForExec(t, 'exec-audit');

  await runExec(guest, { peerId: discoveryKey, code: PROC + 'process.exit(0);' });

  const audit = host.getAudit();
  t.ok(audit.some((e) => e.type === 'peer:exec:started'));
  t.ok(audit.some((e) => e.type === 'peer:exec:finished'));

  const sandboxed = audit.find((e) => e.type === 'peer:exec:sandboxed');
  t.ok(sandboxed, 'sandbox decision recorded');
  t.comment(`sandboxed=${sandboxed.sandboxed} mode=${sandboxed.sandboxMode}`);
});

test('exec - the host echoes fileName and mode back to the guest', async (t) => {
  const { guest, discoveryKey } = await pairForExec(t, 'exec-echo');
  const fileName = 'guest-side-remote-exec.mts';
  const before = guest.getAudit().length;

  await runExec(guest, { peerId: discoveryKey, code: PROC + 'process.exit(0);', fileName });

  const started = guest
    .getAudit()
    .slice(before)
    .find((e) => e.type === 'peer:exec:remote-started');

  t.ok(started, 'guest recorded the remote start');
  t.is(started.fileName, fileName, 'fileName echoed back');
  t.is(started.mode, 'inline', 'mode defaults to inline');
});
