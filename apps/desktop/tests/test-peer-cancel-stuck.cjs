const path = require('node:path');
const fs = require('node:fs');
const createTestnet = require('hyperdht/testnet.js');
const { createStore } = require('../electron/state-store.cjs');

function tmpStoreDir(label) {
  return fs.mkdtempSync(path.join(require('node:os').tmpdir(), `ta-peer-stuck-${label}-`));
}

function waitFor(emitter, eventName, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${eventName} after ${timeoutMs}ms`));
    }, timeoutMs);
    function onEvent(event, payload) {
      if (event !== eventName) return;
      off();
      clearTimeout(timer);
      resolve(payload);
    }
    const off = emitter.on(onEvent);
  });
}

async function main() {
  console.log('[stuck-cancel] creating in-process hyperdht testnet (3 nodes)');
  const testnet = await createTestnet(3);
  const hostStore = await createStore(tmpStoreDir('host'));
  const guestStore = await createStore(tmpStoreDir('guest'));

  const host = require('../electron/peer.cjs');
  delete require.cache[require.resolve('../electron/peer.cjs')];
  const guest = require('../electron/peer.cjs');
  await host.init({ store: hostStore, bootstrap: testnet.bootstrap });
  await guest.init({ store: guestStore, bootstrap: testnet.bootstrap });

  const invite = await host.createInvite({ autoApprove: true });
  // Register paired listeners just before accept so the 30s window starts when the test is actually waiting.
  const guestPaired = waitFor(guest, 'peer:paired', 30_000);
  const hostPaired = waitFor(host, 'peer:paired', 30_000);
  await guest.acceptInvite(invite.invite, {
    userData: { name: 'stuck-guest' },
    code: invite.pairingCode,
  });
  const [hostEvent, guestEvent] = await Promise.all([hostPaired, guestPaired]);
  console.log('[stuck-cancel] paired, discovery:', guestEvent.discoveryKey.slice(0, 16) + '...');

  // A child that ignores SIGTERM; cancel must escalate to SIGKILL and resolve well under 10s.
  const stuckCode = `
    process.on('SIGTERM', () => { /* swallow */ });
    setInterval(() => {}, 1000);
  `;

  const startedAt = Date.now();
  const result = await new Promise((resolve, reject) => {
    const emitter = guest.exec({ peerId: guestEvent.discoveryKey, code: stuckCode });
    let stderr = '';
    let stdout = '';
    emitter.on('stdout', (chunk) => { stdout += chunk; });
    emitter.on('stderr', (chunk) => { stderr += chunk; });
    emitter.on('exit', (info) => resolve({ stdout, stderr, ...info }));
    emitter.on('error', reject);
    // Give the child 1s to start, then cancel; SIGKILL fallback at 3s should land within ~5s.
    setTimeout(() => {
      const ok = guest.cancelExec(guestEvent.discoveryKey);
      if (!ok) reject(new Error('cancelExec returned false'));
    }, 1000);
    setTimeout(() => reject(new Error('cancel did not resolve within 15s - SIGKILL fallback likely failed')), 15_000);
  });
  const elapsedMs = Date.now() - startedAt;
  console.log('[stuck-cancel] result:', { ...result, elapsedMs });

  if (elapsedMs > 10_000) {
    console.error('[stuck-cancel] FAIL: cancel took', elapsedMs, 'ms - SIGKILL fallback did not fire');
    process.exit(1);
  }
  // Either SIGKILL signal or non-zero code both prove the child died.
  const killed = result.signal === 'SIGKILL' || result.signal === 'SIGTERM' || result.code !== 0;
  if (!killed) {
    console.error('[stuck-cancel] FAIL: child was not killed, result:', result);
    process.exit(1);
  }
  console.log('[stuck-cancel] PASS: cancel killed stuck child in', elapsedMs, 'ms via', result.signal || `exit ${result.code}`);

  // After cancel, a fresh exec must work; exec state must be clean.
  const secondRunStartedAt = Date.now();
  const secondResult = await new Promise((resolve, reject) => {
    const emitter = guest.exec({
      peerId: guestEvent.discoveryKey,
      code: 'process.stdout.write("fresh run ok\\n"); process.exit(0);',
    });
    let stdout = '';
    emitter.on('stdout', (chunk) => { stdout += chunk; });
    emitter.on('exit', (info) => resolve({ stdout, ...info }));
    emitter.on('error', reject);
    setTimeout(() => reject(new Error('second run did not start within 10s - state may be stuck')), 10_000);
  });
  const secondElapsed = Date.now() - secondRunStartedAt;
  console.log('[stuck-cancel] second run result:', { ...secondResult, secondElapsed });
  if (!secondResult.stdout.includes('fresh run ok') || secondResult.code !== 0) {
    console.error('[stuck-cancel] FAIL: second run did not complete cleanly');
    process.exit(1);
  }
  console.log('[stuck-cancel] PASS: fresh run started after cancel - state is clean');

  await host.dropPeer(hostEvent.discoveryKey);
  await new Promise((r) => setTimeout(r, 100));
  await host.close();
  await guest.close();
  await testnet.destroy();
  console.log('[stuck-cancel] clean shutdown complete');
}

main().catch((err) => {
  console.error('[stuck-cancel] ERR:', err);
  process.exit(1);
});
