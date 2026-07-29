const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const createTestnet = require('hyperdht/testnet.js');
const { createStore } = require('../electron/state-store.cjs');

function tmpStoreDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ta-peer-exec-${label}-`));
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

async function waitForExecChannel(peerModule, discoveryKeyHex, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        let emitter;
        try {
          emitter = peerModule.exec({ peerId: discoveryKeyHex, code: 'null' });
        } catch (err) {
          reject(err);
          return;
        }
        emitter.on('exit', () => resolve());
        emitter.on('error', reject);
        setTimeout(() => reject(new Error('warmup exec timed out')), 2000);
      });
      return;
    } catch (err) {
      if (!String(err.message).includes('no exec channel')) throw err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`exec channel never opened for ${discoveryKeyHex.slice(0, 16)}...`);
}

async function main() {
  console.log('[test-peer-exec] creating in-process hyperdht testnet (3 nodes)');
  const testnet = await createTestnet(3);
  const bootstrap = testnet.bootstrap;

  const hostDir = tmpStoreDir('host');
  const guestDir = tmpStoreDir('guest');
  const hostStore = await createStore(hostDir);
  const guestStore = await createStore(guestDir);
  console.log('[test-peer-exec] host identity:', hostStore.identity.publicKey.slice(0, 16) + '...');
  console.log('[test-peer-exec] guest identity:', guestStore.identity.publicKey.slice(0, 16) + '...');

  delete require.cache[require.resolve('../electron/peer.cjs')];
  const host = require('../electron/peer.cjs');
  delete require.cache[require.resolve('../electron/peer.cjs')];
  const guest = require('../electron/peer.cjs');

  const hostPairedPromise = waitFor(host, 'peer:paired');
  const guestPairedPromise = waitFor(guest, 'peer:paired');

  await host.init({ store: hostStore, bootstrap });
  await guest.init({ store: guestStore, bootstrap });

  const invite = await host.createInvite({ autoApprove: true });
  console.log('[test-peer-exec] host created invite, pairing code:', invite.pairingCode);

  const acceptResult = await guest.acceptInvite(invite.invite, {
    userData: { name: 'guest-from-exec-test', hostname: os.hostname() },
    code: invite.pairingCode,
    hostIdentity: hostStore.identity.publicKey,
  });
  console.log('[test-peer-exec] guest accepted, discovery:', acceptResult.discoveryKey.slice(0, 16) + '...');

  const [hostEvent, guestEvent] = await Promise.all([hostPairedPromise, guestPairedPromise]);
  if (hostEvent.discoveryKey !== guestEvent.discoveryKey) {
    console.error('[test-peer-exec] FAIL: discovery key mismatch');
    process.exit(1);
  }
  console.log('[test-peer-exec] paired, discovery:', guestEvent.discoveryKey.slice(0, 16) + '...');

  await waitForExecChannel(guest, guestEvent.discoveryKey);
  console.log('[test-peer-exec] exec channel ready');

  const code = [
    'process.stdout.write("hi from host\\n");',
    'process.stdout.write("platform: " + process.platform + "\\n");',
    'process.exit(0);',
  ].join('');

  const result = await new Promise((resolve, reject) => {
    const emitter = guest.exec({ peerId: guestEvent.discoveryKey, code });
    let stdout = '';
    let stderr = '';
    emitter.on('stdout', (chunk) => { stdout += chunk; });
    emitter.on('stderr', (chunk) => { stderr += chunk; });
    emitter.on('exit', (info) => resolve({ stdout, stderr, ...info }));
    emitter.on('error', reject);
    setTimeout(() => reject(new Error('exec timed out')), 10_000);
  });

  console.log('[test-peer-exec] exec result:', result);

  if (!result.stdout.includes('hi from host')) {
    console.error('[test-peer-exec] FAIL: missing expected stdout');
    process.exit(1);
  }
  if (!result.stdout.includes('platform:')) {
    console.error('[test-peer-exec] FAIL: missing platform line');
    process.exit(1);
  }
  if (result.code !== 0) {
    console.error('[test-peer-exec] FAIL: non-zero exit', result);
    process.exit(1);
  }
  if (result.stderr.length > 0) {
    console.error('[test-peer-exec] FAIL: unexpected stderr', result.stderr);
    process.exit(1);
  }
  console.log('[test-peer-exec] PASS: guest exec ran on host, stdout streamed, exit 0');

  const errCode = 'process.stderr.write("boom\\n"); process.exit(7);';
  const errResult = await new Promise((resolve, reject) => {
    const emitter = guest.exec({ peerId: guestEvent.discoveryKey, code: errCode });
    let stderr = '';
    emitter.on('stderr', (chunk) => { stderr += chunk; });
    emitter.on('exit', (info) => resolve({ stderr, ...info }));
    emitter.on('error', reject);
    setTimeout(() => reject(new Error('exec timed out')), 10_000);
  });
  if (errResult.code !== 7) {
    console.error('[test-peer-exec] FAIL: expected exit 7, got', errResult);
    process.exit(1);
  }
  if (!errResult.stderr.includes('boom')) {
    console.error('[test-peer-exec] FAIL: expected stderr "boom"');
    process.exit(1);
  }
  console.log('[test-peer-exec] PASS: stderr streams and exit code propagates');

  const fileCode = [
    'const greeting = "file mode hi";',
    'const n = 41 + 1;',
    'process.stdout.write(greeting + " n=" + n + " script=" + process.argv[1] + "\\n");',
    'process.stdout.write("execArgv=" + JSON.stringify(process.execArgv) + "\\n");',
    'process.exit(0);',
  ].join('\n');
  const fileResult = await new Promise((resolve, reject) => {
    const emitter = guest.exec({
      peerId: guestEvent.discoveryKey,
      code: fileCode,
      mode: 'file',
      argv: ['--no-warnings', '--no-deprecation'],
    });
    let stdout = '';
    emitter.on('stdout', (chunk) => { stdout += chunk; });
    emitter.on('stderr', (chunk) => process.stderr.write(chunk));
    emitter.on('exit', (info) => resolve({ stdout, ...info }));
    emitter.on('error', reject);
    setTimeout(() => reject(new Error('file-mode exec timed out')), 10_000);
  });
  console.log('[test-peer-exec] file-mode result:', fileResult);
  if (!fileResult.stdout.includes('file mode hi') || !fileResult.stdout.includes('n=42')) {
    console.error('[test-peer-exec] FAIL: file mode did not run');
    process.exit(1);
  }
  if (!fileResult.stdout.includes('script=') || !fileResult.stdout.includes('.mts')) {
    console.error('[test-peer-exec] FAIL: file mode did not pass script path as argv[1]');
    process.exit(1);
  }
  if (!fileResult.stdout.includes('"--no-warnings"') || !fileResult.stdout.includes('"--no-deprecation"')) {
    console.error('[test-peer-exec] FAIL: file mode did not pass argv to node');
    process.exit(1);
  }
  if (fileResult.code !== 0) {
    console.error('[test-peer-exec] FAIL: file mode non-zero exit');
    process.exit(1);
  }
  console.log('[test-peer-exec] PASS: file mode runs file with argv, .mts script path, execArgv flags');

  let threwOnBadMode = false;
  try {
    guest.exec({ peerId: guestEvent.discoveryKey, code: 'x', mode: 'wat' });
  } catch (err) {
    threwOnBadMode = String(err.message).includes("mode must be 'inline' or 'file'");
  }
  if (!threwOnBadMode) {
    console.error('[test-peer-exec] FAIL: bad mode did not throw');
    process.exit(1);
  }
  console.log('[test-peer-exec] PASS: bad mode rejected');

  const longRunCode = 'setInterval(() => process.stdout.write("tick\\n"), 50);';
  let cancelEmitter;
  const cancelResult = await new Promise((resolve, reject) => {
    cancelEmitter = guest.exec({ peerId: guestEvent.discoveryKey, code: longRunCode });
    let stdout = '';
    let cancelled = false;
    cancelEmitter.on('stdout', (chunk) => {
      stdout += chunk;
      if (!cancelled && stdout.length > 30) {
        cancelled = true;
        const ok = guest.cancelExec(guestEvent.discoveryKey);
        if (!ok) reject(new Error('cancelExec returned false'));
      }
    });
    cancelEmitter.on('stderr', (chunk) => process.stderr.write(chunk));
    cancelEmitter.on('exit', (info) => resolve({ stdout, ...info }));
    cancelEmitter.on('error', reject);
    setTimeout(() => reject(new Error('cancel exec timed out')), 10_000);
  });
  console.log('[test-peer-exec] cancel result:', cancelResult);
  if (!cancelResult.stdout.includes('tick')) {
    console.error('[test-peer-exec] FAIL: long-run did not produce any output before cancel');
    process.exit(1);
  }
  const killedBySignal = cancelResult.signal === 'SIGTERM' || cancelResult.code !== 0;
  if (!killedBySignal) {
    console.error('[test-peer-exec] FAIL: cancel did not kill the child', cancelResult);
    process.exit(1);
  }
  console.log('[test-peer-exec] PASS: cancelExec killed the in-flight child');

  const audit = host.getAudit();
  const execStarted = audit.find((e) => e.type === 'peer:exec:started');
  const execFinished = audit.find((e) => e.type === 'peer:exec:finished');
  if (!execStarted || !execFinished) {
    console.error('[test-peer-exec] FAIL: audit log missing exec:started or exec:finished', { execStarted, execFinished });
    process.exit(1);
  }
  console.log('[test-peer-exec] PASS: audit log has peer:exec:started and peer:exec:finished');

  // The host must echo fileName and mode back to the guest on remote exec start.
  const remoteRunFile = 'guest-side-remote-exec.mts';
  const auditBefore = guest.getAudit().length;
  await new Promise((resolve, reject) => {
    const emitter = guest.exec({
      peerId: guestEvent.discoveryKey,
      code: 'process.exit(0);',
      fileName: remoteRunFile,
    });
    emitter.on('exit', () => resolve());
    emitter.on('error', reject);
    setTimeout(() => reject(new Error('remote-started audit timed out')), 10_000);
  });
  const guestAudit = guest.getAudit();
  const remoteStarted = guestAudit
    .slice(auditBefore)
    .find((e) => e.type === 'peer:exec:remote-started');
  if (!remoteStarted) {
    console.error('[test-peer-exec] FAIL: guest audit missing peer:exec:remote-started');
    process.exit(1);
  }
  if (remoteStarted.fileName !== remoteRunFile) {
    console.error('[test-peer-exec] FAIL: remote-started fileName mismatch', { got: remoteStarted.fileName, want: remoteRunFile });
    process.exit(1);
  }
  if (remoteStarted.mode !== 'inline') {
    console.error('[test-peer-exec] FAIL: remote-started mode should default to inline', { got: remoteStarted.mode });
    process.exit(1);
  }
  console.log('[test-peer-exec] PASS: peer:exec:remote-started carries fileName and mode');

  let cancelWithoutExec = guest.cancelExec(guestEvent.discoveryKey);
  if (cancelWithoutExec !== false) {
    console.error('[test-peer-exec] FAIL: cancelExec with no in-flight exec should return false, got', cancelWithoutExec);
    process.exit(1);
  }
  console.log('[test-peer-exec] PASS: cancelExec on idle peer returns false');

  await host.dropPeer(hostEvent.discoveryKey);
  await new Promise((r) => setTimeout(r, 100));
  await host.close();
  await guest.close();
  await testnet.destroy();
  console.log('[test-peer-exec] clean shutdown complete');
}

main().catch((err) => {
  console.error('[test-peer-exec] ERR:', err);
  process.exit(1);
});
