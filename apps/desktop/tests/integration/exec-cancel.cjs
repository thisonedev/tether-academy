'use strict';

// Cancel is a security property: it's how a host stops remote code it has
// already agreed to run. These were known-failing until the SIGKILL escalation was fixed.

const test = require('brittle');

const { bareRequires, pairForExec, runExec } = require('../helpers/index.cjs');
const { SIGKILL_GRACE_MS } = require('../../workers/peer/exec-host.cjs');

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
