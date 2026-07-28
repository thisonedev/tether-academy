const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const createTestnet = require('hyperdht/testnet.js');
const { createStore } = require('../electron/state-store.cjs');

function tmpStoreDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ta-peer-sec-${label}-`));
}

function waitFor(emitter, eventName, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${eventName}`));
    }, timeoutMs);
    function onEvent(event, payload) {
      if (event !== eventName) return;
      if (predicate && !predicate(payload)) return;
      off();
      clearTimeout(timer);
      resolve(payload);
    }
    const off = emitter.on(onEvent);
  });
}

function freshRequire(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

async function makePeers(label) {
  const testnet = await createTestnet(3);
  const hostStore = await createStore(tmpStoreDir(`host-${label}`));
  const guestStore = await createStore(tmpStoreDir(`guest-${label}`));
  const host = freshRequire('../electron/peer.cjs');
  const guest = freshRequire('../electron/peer.cjs');
  await host.init({ store: hostStore, bootstrap: testnet.bootstrap });
  await guest.init({ store: guestStore, bootstrap: testnet.bootstrap });
  return { testnet, host, guest };
}

async function cleanup(peers) {
  await Promise.all(peers.map((p) => Promise.race([p.close(), new Promise((r) => setTimeout(r, 2000))]).catch(() => {})));
}

async function testApprovalFlow() {
  console.log('[sec] === approval flow ===');
  const { testnet, host, guest } = await makePeers('approve');

  const pendingPromise = waitFor(host, 'peer:pending');
  const pairedPromise = waitFor(host, 'peer:paired');

  console.log('[sec]   creating invite...');
  const invite = await host.createInvite();
  console.log('[sec]   invite created, firing acceptInvite...');
  const acceptPromise = guest.acceptInvite(invite.invite, {
    userData: { name: 'guest-needs-approval', hostname: os.hostname() },
  });

  const pending = await pendingPromise;
  console.log('[sec]   host got pending request', pending.requestId.slice(0, 8));

  const pendingList = host.listPending();
  if (pendingList.length !== 1) {
    console.error('[sec] FAIL: listPending expected 1, got', pendingList.length);
    process.exit(1);
  }
  if (pendingList[0].userData?.name !== 'guest-needs-approval') {
    console.error('[sec] FAIL: pending userData missing', pendingList[0].userData);
    process.exit(1);
  }

  const auditBefore = host.getAudit();
  const approved = await host.approve(pending.requestId);
  if (!approved) {
    console.error('[sec] FAIL: approve returned false');
    process.exit(1);
  }

  const paired = await pairedPromise;
  if (paired.discoveryKey !== pending.discoveryKey) {
    console.error('[sec] FAIL: paired discoveryKey mismatch');
    process.exit(1);
  }

  const auditAfter = host.getAudit();
  const types = auditAfter.map((e) => e.type);
  if (!types.includes('peer:pending') || !types.includes('peer:approved') || !types.includes('peer:paired')) {
    console.error('[sec] FAIL: audit log missing expected types', types);
    process.exit(1);
  }
  console.log('[sec]   audit log types:', types.join(' -> '));

  const peers = host.listPeers();
  if (peers.length !== 1) {
    console.error('[sec] FAIL: expected 1 peer after approve, got', peers.length);
    process.exit(1);
  }
  console.log('[sec] PASS: approval flow + audit');

  await acceptPromise.catch(() => {});
  await cleanup([host, guest]);
  await testnet.destroy();
}

async function testRejectFlow() {
  console.log('[sec] === reject flow ===');
  const { testnet, host, guest } = await makePeers('reject');

  const pendingPromise = waitFor(host, 'peer:pending');

  const invite = await host.createInvite();
  const acceptPromise = guest.acceptInvite(invite.invite, {
    userData: { name: 'guest-to-reject' },
  });

  const pending = await pendingPromise;
  const rejected = await host.reject(pending.requestId);
  if (!rejected) {
    console.error('[sec] FAIL: reject returned false');
    process.exit(1);
  }
  if (host.listPending().length !== 0) {
    console.error('[sec] FAIL: pending list not empty after reject');
    process.exit(1);
  }
  if (host.listPeers().length !== 0) {
    console.error('[sec] FAIL: peers list not empty after reject');
    process.exit(1);
  }

  const auditTypes = host.getAudit().map((e) => e.type);
  if (!auditTypes.includes('peer:rejected')) {
    console.error('[sec] FAIL: audit missing peer:rejected', auditTypes);
    process.exit(1);
  }
  console.log('[sec] PASS: reject flow + audit');

  acceptPromise.catch(() => {});
  await cleanup([host, guest]);
  await testnet.destroy();
}

async function testLockdown() {
  console.log('[sec] === lockdown flow ===');
  const { testnet, host, guest } = await makePeers('lockdown');

  const pairedPromise = waitFor(guest, 'peer:paired');
  const invite = await host.createInvite({ autoApprove: true });
  await guest.acceptInvite(invite.invite, { userData: { name: 'guest-for-lockdown' } });
  await pairedPromise;

  if (guest.listPeers().length !== 1) {
    console.error('[sec] FAIL: guest expected 1 peer before lockdown, got', guest.listPeers().length);
    process.exit(1);
  }

  const dropped = await guest.lockdown();
  if (dropped !== 1) {
    console.error('[sec] FAIL: lockdown dropped', dropped, 'expected 1');
    process.exit(1);
  }
  if (guest.listPeers().length !== 0) {
    console.error('[sec] FAIL: guest still has peers after lockdown');
    process.exit(1);
  }
  const audit = guest.getAudit();
  const lockdownEntry = audit.find((e) => e.type === 'peer:lockdown');
  if (!lockdownEntry || lockdownEntry.dropped !== 1) {
    console.error('[sec] FAIL: lockdown audit entry missing/wrong', lockdownEntry);
    process.exit(1);
  }
  console.log('[sec] PASS: lockdown dropped 1 peer + audit');

  await cleanup([host, guest]);
  await testnet.destroy();
}

async function testLockdownWithPending() {
  console.log('[sec] === lockdown rejects pending ===');
  const { testnet, host, guest } = await makePeers('lockdown-pending');

  const pendingPromise = waitFor(host, 'peer:pending');
  const invite = await host.createInvite();
  const acceptPromise = guest.acceptInvite(invite.invite, { userData: { name: 'never-approved' } });
  const pending = await pendingPromise;

  if (host.listPending().length !== 1) {
    console.error('[sec] FAIL: expected 1 pending');
    process.exit(1);
  }
  const dropped = await host.lockdown();
  if (dropped !== 1) {
    console.error('[sec] FAIL: lockdown should drop the pending request too, got', dropped);
    process.exit(1);
  }
  if (host.listPending().length !== 0) {
    console.error('[sec] FAIL: pending still present after lockdown');
    process.exit(1);
  }
  console.log('[sec] PASS: lockdown dropped pending request');

  acceptPromise.catch(() => {});
  await cleanup([host, guest]);
  await testnet.destroy();
}

(async () => {
  try {
    await testApprovalFlow();
    await testRejectFlow();
    await testLockdown();
    await testLockdownWithPending();
    console.log('[sec] all security tests passed');
  } catch (err) {
    console.error('[sec] ERR:', err);
    process.exit(1);
  }
})();
