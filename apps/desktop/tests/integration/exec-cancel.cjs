'use strict';

// Cancel is a security property: it's how a host stops remote code it has
// already agreed to run. These were known-failing until the SIGKILL escalation was fixed.

const test = require('brittle');

const { bareRequires, pairForExec, runExec } = require('../helpers/index.cjs');
const { SIGKILL_GRACE_MS, _setTestStaleRunMs } = require('../../workers/peer/exec-host.cjs');

// run-tests.mjs only keeps lines matching /^\s*not ok/ in its CI summary;
// a raw newline in a failure message would drop everything after it.
const oneLine = (s) => s.replace(/\s*\n\s*/g, ' | ');

// A cancel that never arrives shows up as a timeout, so it becomes a value rather than a rejection that would abort the rest of the file.
const settled = (promise) =>
  promise.then(
    (result) => ({ result, timedOut: false }),
    (err) => ({ err, timedOut: /timed out/.test(err.message) }),
  );

// Swallows SIGTERM, so only SIGKILL can end it.
const IGNORES_SIGTERM = `
  ${bareRequires('process')}
  process.on('SIGTERM', () => {});
  process.stdout.write('started\\n');
  setInterval(() => {}, 1000);
`;

// SIGTERM, then SIGKILL 3s later, plus round-trip. 10s is generous.
const CANCEL_BUDGET_MS = 10_000;

// exec-host.cjs's SIGTERM->grace->SIGKILL escalation keeps running in this
// process after CANCEL_BUDGET_MS gives up on it. If the test exits first,
// the fixture (already ignoring SIGTERM) is orphaned for good.
const outlastEscalation = () => new Promise((resolve) => setTimeout(resolve, SIGKILL_GRACE_MS + 2_000));

test('exec-cancel - escalates to SIGKILL when the child ignores SIGTERM', async (t) => {
  const { guest, discoveryKey } = await pairForExec(t, 'cancel-sigkill');

  const startedAt = Date.now();
  const { result, timedOut } = await settled(
    runExec(
      guest,
      {
        peerId: discoveryKey,
        code: IGNORES_SIGTERM,
        onStdout: (stdout) => {
          if (stdout.includes('started')) guest.cancelExec(discoveryKey);
        },
      },
      CANCEL_BUDGET_MS,
    ),
  );
  const elapsed = Date.now() - startedAt;

  if (timedOut) await outlastEscalation();

  t.absent(
    timedOut,
    `exec never resolved within ${CANCEL_BUDGET_MS}ms. cancelExec reported success but the child outlived it`,
  );
  if (timedOut) return;

  t.comment(`cancel resolved in ${elapsed}ms via ${result.signal ?? `exit ${result.code}`}`);
  t.ok(
    result.signal === 'SIGKILL' || result.signal === 'SIGTERM' || result.code !== 0,
    'child was killed rather than left running',
  );
});

// A cancel that kills the child but leaves exec state behind would block the peer from ever running anything again.
test('exec-cancel - the peer accepts a fresh exec afterwards', async (t) => {
  const { guest, discoveryKey } = await pairForExec(t, 'cancel-then-run');

  const first = await settled(
    runExec(
      guest,
      {
        peerId: discoveryKey,
        code: IGNORES_SIGTERM,
        onStdout: (stdout) => {
          if (stdout.includes('started')) guest.cancelExec(discoveryKey);
        },
      },
      CANCEL_BUDGET_MS,
    ),
  ); // whether the cancel itself worked is asserted above
  if (first.timedOut) await outlastEscalation();

  const fresh = await settled(
    runExec(guest, {
      peerId: discoveryKey,
      code: bareRequires('process') + 'process.stdout.write("fresh run ok\\n"); process.exit(0);',
    }),
  );

  t.absent(
    fresh.err,
    `a fresh exec must be accepted after a cancel; got: ${fresh.err?.message ?? 'no error'}`,
  );
  if (fresh.err) return;

  const detail = oneLine(
    `code=${fresh.result.code} signal=${fresh.result.signal} ` +
      `stdout=${fresh.result.stdout} stderr=${fresh.result.stderr}`,
  );
  t.ok(fresh.result.stdout.includes('fresh run ok'), `the new exec actually ran; ${detail}`);
  t.is(fresh.result.code, 0, `exec state was not left stuck; ${detail}`);
});

// No cancel this time: a run that never replies at all (not even 'started')
// used to wedge the guest's own exec lock forever, with no recovery short
// of an app restart. _testHooks shortens the real multi-minute wait to
// something a test can actually run.
test('exec-cancel - a run that never replies frees the peer on its own', async (t) => {
  const { guest, discoveryKey } = await pairForExec(t, 'stale-no-reply');
  guest._testHooks.setGuestExecStaleMs(800);
  // Module-level in exec-host.cjs, shared by every peer in this process; reset
  // so it doesn't leak into tests that run after this one. Well under the
  // guest's own 800ms so it has always elapsed by the time the retry lands.
  t.teardown(() => _setTestStaleRunMs(null));
  _setTestStaleRunMs(50);

  const stuck = await settled(
    runExec(guest, { peerId: discoveryKey, code: 'for (;;) {}' }, 5_000),
  );
  t.ok(stuck.err, 'the stale timeout rejects the stuck run');
  t.ok(/no reply from peer/.test(stuck.err?.message ?? ''), `got: ${stuck.err?.message}`);

  // A fresh request right after landed exactly as the host was recovering the
  // stale slot; give the full recovery + spawn pipeline (identity wait,
  // security scan, sandbox setup) room to finish rather than the stuck run's
  // own tight stale budget.
  guest._testHooks.setGuestExecStaleMs(10_000);
  const fresh = await settled(
    runExec(guest, {
      peerId: discoveryKey,
      code: bareRequires('process') + 'process.stdout.write("fresh run ok\\n"); process.exit(0);',
    }),
  );
  t.absent(fresh.err, `a fresh exec must be accepted afterwards; got: ${fresh.err?.message ?? 'no error'}`);
  if (!fresh.err) {
    const detail = oneLine(
      `code=${fresh.result.code} signal=${fresh.result.signal} ` +
        `stdout=${fresh.result.stdout} stderr=${fresh.result.stderr}`,
    );
    t.ok(fresh.result.stdout.includes('fresh run ok'), `the new exec actually ran; ${detail}`);
  }

  try {
    guest.cancelExec(discoveryKey);
  } catch {}
});

// The stale window is an idle timeout, not a runtime budget. A lesson that
// downloads a multi-GB model runs far past it while the peer is still working,
// so replies have to push it back.
test('exec-cancel - steady output keeps a run alive past the stale window', async (t) => {
  const { guest, discoveryKey } = await pairForExec(t, 'stale-refresh');
  // Wide enough to cover the host's spawn pipeline before the first reply,
  // narrow enough that the 8s run below cannot fit inside one window.
  guest._testHooks.setGuestExecStaleMs(3_000);
  t.teardown(() => guest._testHooks.setGuestExecStaleMs(null));

  // ~8s of run in 400ms beats: no single gap comes near the window, but the
  // total is far past it.
  const code =
    bareRequires('process') +
    'let n = 0;' +
    'const t = setInterval(() => {' +
    '  process.stdout.write("beat " + (++n) + "\\n");' +
    '  if (n === 20) { clearInterval(t); process.exit(0); }' +
    '}, 400);';

  const out = await settled(runExec(guest, { peerId: discoveryKey, code }, 30_000));
  t.absent(out.err, `steady output must not read as no reply; got: ${oneLine(out.err?.message ?? '')}`);
  if (!out.err) {
    t.ok(out.result.stdout.includes('beat 20'), `ran to completion; got: ${oneLine(out.result.stdout)}`);
  }
});
