'use strict';

// A performance guard: blind-pairing polls the DHT every 30s, so without the
// wake peer.cjs pushes, an approved guest sits on a spinner for up to half a
// minute. As a latency budget, this can fail if the machine is busy, hence several runs.

const test = require('brittle');
const os = require('node:os');

const { createPeers, waitFor } = require('../helpers/index.cjs');

const RUNS = 3;
// Generous against the 30s poll it is guarding; anything near the poll cycle means the wake did not fire.
const BUDGET_MS = 2000;
const PAIR_TIMEOUT_MS = 30_000;

async function measureApprovalLatency(t, label) {
  const { peers: [host, guest] } = await createPeers(t, 2, { label });

  const pendingPromise = waitFor(host, 'peer:pending', null, PAIR_TIMEOUT_MS);
  const invite = await host.createInvite();
  const accepted = guest
    .acceptInvite(invite.invite, {
      userData: { name: 'guest-wake-test', hostname: os.hostname() },
      code: invite.pairingCode,
    })
    .catch(() => {});

  const pending = await pendingPromise;
  const guestPaired = waitFor(guest, 'peer:paired', null, PAIR_TIMEOUT_MS);

  const start = Date.now();
  t.is(await host.approve(pending.requestId), true);
  await guestPaired;
  const elapsed = Date.now() - start;

  await accepted;
  return elapsed;
}

test('pairing-wake - the guest learns of approval without waiting for a DHT poll', async (t) => {
  const timings = [];
  for (let i = 0; i < RUNS; i++) {
    timings.push(await measureApprovalLatency(t, `wake-run-${i}`));
  }

  const max = Math.max(...timings);
  const avg = Math.round(timings.reduce((a, b) => a + b, 0) / timings.length);
  t.comment(`approval -> guest paired: runs=[${timings.join(', ')}]ms avg=${avg}ms max=${max}ms`);

  t.ok(
    max < BUDGET_MS,
    `slowest run ${max}ms must stay under ${BUDGET_MS}ms; near 30s means the wake never fired`,
  );
});
