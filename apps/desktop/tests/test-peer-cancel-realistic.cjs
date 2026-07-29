// Mimics the real app's exec flow: spawns a child running loadModel + completion, then tests cancel mid-run.

const path = require('node:path');
const fs = require('node:fs');
const createTestnet = require('hyperdht/testnet.js');
const { createStore } = require('../electron/state-store.cjs');

function tmpStoreDir(label) {
  return fs.mkdtempSync(path.join(require('node:os').tmpdir(), `ta-real-${label}-`));
}

function waitFor(emitter, eventName, timeoutMs = 60_000) {
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
  console.log('[real-cancel] creating in-process hyperdht testnet (3 nodes)');
  const testnet = await createTestnet(3);
  const hostStore = await createStore(tmpStoreDir('host'));
  const guestStore = await createStore(tmpStoreDir('guest'));

  const host = require('../electron/peer.cjs');
  delete require.cache[require.resolve('../electron/peer.cjs')];
  const guest = require('../electron/peer.cjs');

  await host.init({ store: hostStore, bootstrap: testnet.bootstrap });
  await guest.init({ store: guestStore, bootstrap: testnet.bootstrap });

  const hostPaired = waitFor(host, 'peer:paired', 30_000);
  const guestPaired = waitFor(guest, 'peer:paired', 30_000);

  const invite = await host.createInvite({ autoApprove: true });
  await guest.acceptInvite(invite.invite, {
    userData: { name: 'real-cancel-guest' },
    code: invite.pairingCode,
  });
  const [hostEvent, guestEvent] = await Promise.all([hostPaired, guestPaired]);
  console.log('[real-cancel] paired, discovery:', guestEvent.discoveryKey.slice(0, 16) + '...');

  // A child that takes ~60s and ignores SIGTERM; SIGKILL must fire to kill it.
  const longCode = `
    process.on('SIGTERM', () => {});
    console.log('starting up...');
    setInterval(() => {}, 60000);
  `;

  const startedAt = Date.now();
  const result = await new Promise((resolve, reject) => {
    const emitter = guest.exec({
      peerId: guestEvent.discoveryKey,
      code: longCode,
      mode: 'inline',
    });
    let stdout = '';
    let stderr = '';
    emitter.on('stdout', (c) => { stdout += c; });
    emitter.on('stderr', (c) => { stderr += c; });
    emitter.on('exit', (info) => resolve({ stdout, stderr, ...info, resolvedAt: Date.now() }));
    emitter.on('error', (err) => resolve({ stdout, stderr, error: err.message, resolvedAt: Date.now() }));
    // Cancel after 2s, well before the child's natural 10s completion.
    setTimeout(() => {
      const ok = guest.cancelExec(guestEvent.discoveryKey);
      console.log('[real-cancel]   cancelExec returned:', ok, 'at', Date.now() - startedAt, 'ms');
    }, 2000);
    // Generous timeout: SIGTERM + 3s SIGKILL fallback.
    setTimeout(() => reject(new Error('cancel did not resolve within 60s')), 60_000);
  });
  const elapsedMs = result.resolvedAt - startedAt;
  console.log('[real-cancel] result resolved in', elapsedMs, 'ms');
  console.log('[real-cancel]   code:', result.code, 'signal:', result.signal);
  console.log('[real-cancel]   stdout:', JSON.stringify(result.stdout));
  console.log('[real-cancel]   error:', result.error);

  if (elapsedMs > 8000) {
    console.error('[real-cancel] FAIL: cancel took too long (' + elapsedMs + 'ms) - SIGKILL fallback likely not firing');
    process.exit(1);
  }
  if (result.code === 0 && result.signal == null) {
    console.error('[real-cancel] FAIL: child was not killed (got clean exit)');
    process.exit(1);
  }
  console.log('[real-cancel] PASS: cancel killed child via', result.signal || `exit ${result.code}`, 'in', elapsedMs, 'ms');

  // Second test: an un-cancelled run completes naturally and shows on both sides.
  const naturalCode = 'console.log("hi from host"); process.exit(0);';
  const naturalResult = await new Promise((resolve, reject) => {
    const emitter = guest.exec({
      peerId: guestEvent.discoveryKey,
      code: naturalCode,
      mode: 'inline',
    });
    let stdout = '';
    emitter.on('stdout', (c) => { stdout += c; });
    emitter.on('exit', (info) => resolve({ stdout, ...info }));
    emitter.on('error', reject);
    setTimeout(() => reject(new Error('natural run did not resolve within 10s')), 10_000);
  });
  if (naturalResult.code !== 0 || !naturalResult.stdout.includes('hi from host')) {
    console.error('[real-cancel] FAIL: natural run did not complete cleanly', naturalResult);
    process.exit(1);
  }
  console.log('[real-cancel] PASS: natural run completed cleanly, exit 0, stdout streamed back');

  await host.dropPeer(hostEvent.discoveryKey);
  await new Promise((r) => setTimeout(r, 100));
  await host.close();
  await guest.close();
  await testnet.destroy();
  console.log('[real-cancel] clean shutdown complete');
}

main().catch((err) => {
  console.error('[real-cancel] ERR:', err);
  process.exit(1);
});
