'use strict';

// Regression: approving the instant peer:pending arrived sent the response
// before the guest's channel was open, costing a 30-minute hang; the response
// is now buffered and flushed. Repeats since a race is intermittent.

const test = require('brittle');
const os = require('node:os');

const { createPeers, createTestnetFor, waitFor } = require('../helpers/index.cjs');

const ITERATIONS = 10;
// The host is local, so its own event should be immediate.
const HOST_BUDGET_MS = 1000;
// Still far below the 30s DHT poll, so staying under this proves the response did not arrive by polling.
const GUEST_BUDGET_MS = 5000;

// Stamps its own resolution time so host and guest are measured independently. Must be called before
// approve(), since the host's own peer:paired can fire during that call.
function stampedWait(emitter, eventName, timeoutMs) {
  return waitFor(emitter, eventName, null, timeoutMs).then((payload) => ({
    payload,
    at: Date.now(),
  }));
}

async function pairImmediately(t, testnet, iteration, sabotage) {
  const { peers: [host, guest] } = await createPeers(t, 2, {
    testnet,
    label: `race-${iteration}`,
  });
  sabotage(host);

  const pendingPromise = waitFor(host, 'peer:pending', null, 10_000);
  const invite = await host.createInvite();
  const accepted = guest
    .acceptInvite(invite.invite, {
      userData: { name: `guest-race-${iteration}`, hostname: os.hostname() },
      code: invite.pairingCode,
    })
    .catch(() => {});
  const pending = await pendingPromise;

  const hostResult = stampedWait(host, 'peer:paired', HOST_BUDGET_MS * 2);
  const guestResult = stampedWait(guest, 'peer:paired', GUEST_BUDGET_MS);

  // No delay before approving. This is the race.
  const start = Date.now();
  const approved = await host.approve(pending.requestId);

  const [hostSide, guestSide] = await Promise.all([hostResult, guestResult]);
  await accepted;

  return {
    approved,
    hostMs: hostSide.at - start,
    guestMs: guestSide.at - start,
    matched:
      hostSide.payload.discoveryKey === guestSide.payload.discoveryKey &&
      hostSide.payload.autobaseKey === guestSide.payload.autobaseKey &&
      hostSide.payload.role === 'host' &&
      guestSide.payload.role === 'guest',
  };
}

async function runScenario(t, label, sabotage) {
  const testnet = await createTestnetFor(t);
  const hostTimes = [];
  const guestTimes = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const r = await pairImmediately(t, testnet, `${label}-${i}`, sabotage);
    t.ok(r.approved, `iteration ${i}: approve succeeded`);
    t.ok(r.matched, `iteration ${i}: both sides agree on keys and roles`);
    hostTimes.push(r.hostMs);
    guestTimes.push(r.guestMs);
  }

  const maxHost = Math.max(...hostTimes);
  const maxGuest = Math.max(...guestTimes);
  t.comment(`${label}: host max=${maxHost}ms, guest max=${maxGuest}ms over ${ITERATIONS} iterations`);
  return { maxHost, maxGuest };
}

test('pairing-race - immediate approve pairs reliably with every path available', async (t) => {
  const { maxHost, maxGuest } = await runScenario(t, 'all-paths', () => {});

  t.ok(maxHost < HOST_BUDGET_MS, `host paired within ${HOST_BUDGET_MS}ms every time`);
  t.ok(maxGuest < GUEST_BUDGET_MS, `guest paired within ${GUEST_BUDGET_MS}ms every time`);
});

// With the DHT and the blind-pairing channel both cut, only the buffered exec-channel flush can deliver the response.
test('pairing-race - immediate approve pairs reliably over the exec channel alone', async (t) => {
  const { maxHost, maxGuest } = await runScenario(t, 'exec-only', (host) => {
    host._testHooks.setSkipDhtPut(true);
    host._testHooks.setSkipBlindPairingChannel(true);
    t.teardown(() => {
      host._testHooks.setSkipDhtPut(false);
      host._testHooks.setSkipBlindPairingChannel(false);
    });
  });

  t.ok(maxHost < HOST_BUDGET_MS, `host paired within ${HOST_BUDGET_MS}ms every time`);
  t.ok(
    maxGuest < GUEST_BUDGET_MS,
    `guest paired within ${GUEST_BUDGET_MS}ms every time; slower means only the DHT poll delivered`,
  );
});
