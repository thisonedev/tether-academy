const Hyperswarm = require('hyperswarm');
const BlindPairing = require('blind-pairing');
const Protomux = require('protomux');
const c = require('compact-encoding');
const crypto = require('node:crypto');
const hypercoreCrypto = require('hypercore-crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pairingCode = require('./pairing-code.cjs');

const DOCK_HIDE_SHIM = path.join(__dirname, 'dock-hide-shim.cjs');
const DOCK_HIDE_ARGS = process.platform === 'darwin' ? ['--require', DOCK_HIDE_SHIM] : [];

const AUDIT_CAP = 1000;
const BUILD_ID = 'tether-academy-desktop';
const EXEC_PROTOCOL = 'academy-exec';

// Re-derive the reply keypair manually: blind-pairing's poll adds the peer to
// its skip cache before approve, so the response would never land on the DHT.
const [BLIND_NS_EPHEMERAL, BLIND_NS_REPLY] = hypercoreCrypto.namespace('blind-pairing/dht', 3);
function deriveReplyKeyPair(token) {
  return hypercoreCrypto.keyPair(hypercoreCrypto.hash([BLIND_NS_REPLY, token]));
}

const toHex = (buf) => {
  if (buf == null) return null;
  if (typeof buf === 'string') return buf;
  return Buffer.from(buf).toString('hex');
};

const fromHex = (hex) => Buffer.from(hex, 'hex');

function defaultDeviceName() {
  try {
    const username = os.userInfo().username;
    const host = os.hostname();
    if (username && host) return `${username}@${host}`;
  } catch {}
  return os.hostname();
}

let swarm = null;
let pairing = null;
let identity = null;

const members = new Map();
const candidates = new Map();
const peers = new Map();
const pendingRequests = new Map();
const pendingByDiscovery = new Set();
const pendingByInvite = new Set();
const auditLog = [];
const listeners = new Set();
const execChannels = new Map();
const execStates = new Map();

function emit(event, payload) {
  for (const listener of listeners) {
    try {
      listener(event, payload);
    } catch (err) {
      console.warn('[peer] listener error:', err?.message ?? err);
    }
  }
}

function appendAudit(type, payload) {
  const entry = { type, timestamp: Date.now(), ...payload };
  auditLog.push(entry);
  if (auditLog.length > AUDIT_CAP) auditLog.shift();
  emit('peer:audit', entry);
}

function safeParseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return { raw: str };
  }
}

async function init({ store, bootstrap = null }) {
  if (pairing) return pairing;
  if (!store?.identity) {
    throw new Error('peer.init: state-store identity is required');
  }
  identity = store.identity;

  const seed = fromHex(identity.publicKey);
  swarm = bootstrap ? new Hyperswarm({ seed, bootstrap }) : new Hyperswarm({ seed });

  await swarm.dht.fullyBootstrapped();
  pairing = new BlindPairing(swarm, { poll: 30_000 });

  console.log(
    `[peer] ready, identity pubkey ${identity.publicKey.slice(0, 16)}..., ` +
      `swarm pubkey ${toHex(swarm.keyPair.publicKey).slice(0, 16)}...`,
  );

  swarm.on('connection', onSwarmConnection);

  return pairing;
}

function onSwarmConnection(conn) {
  const mux = Protomux.from(conn);
  for (const ref of pairing.active.values()) {
    if (ref.discoveryKey) attachExecProtocol(mux, ref.discoveryKey);
  }
}

function attachExecToAllConnections(discoveryKey) {
  for (const conn of swarm.connections) {
    const mux = Protomux.from(conn);
    attachExecProtocol(mux, discoveryKey);
  }
}

function attachExecProtocol(mux, discoveryKey) {
  const discoveryKeyHex = toHex(discoveryKey);
  const existing = execChannels.get(discoveryKeyHex);
  if (existing?.channel) return;
  const channelOpts = {
    protocol: EXEC_PROTOCOL,
    id: discoveryKey,
    messages: [
      { encoding: c.buffer, onmessage: (buf) => routeExecMessage(discoveryKeyHex, buf) },
    ],
    onclose: () => {
      if (peers.has(discoveryKeyHex)) {
        dropPeer(discoveryKeyHex).catch(() => {});
      }
      if (execChannels.get(discoveryKeyHex)?.channel?.onclose === channelOpts.onclose) {
        execChannels.delete(discoveryKeyHex);
      }
    },
  };
  mux.pair({ protocol: EXEC_PROTOCOL, id: discoveryKey }, () => {
    if (execChannels.get(discoveryKeyHex)?.channel) return;
    const ch = mux.createChannel(channelOpts);
    if (!ch) return;
    execChannels.set(discoveryKeyHex, { channel: ch, mux });
    ch.open();
  });
  if (!members.has(discoveryKeyHex)) return;
  const ch = mux.createChannel(channelOpts);
  if (!ch) return;
  execChannels.set(discoveryKeyHex, { channel: ch, mux });
  ch.open();
}

function routeExecMessage(discoveryKeyHex, buf) {
  // Pairing-wake may arrive before the peer entry exists; route it before the lookup.
  if (isPairingWake(buf)) {
    triggerPairingPoll(discoveryKeyHex);
    return;
  }
  const peer = peers.get(discoveryKeyHex);
  if (!peer) return;
  if (peer.role === 'host') {
    handleExecRequest(discoveryKeyHex, buf);
  } else {
    handleExecReply(discoveryKeyHex, buf);
  }
}

function isPairingWake(buf) {
  if (!buf) return false;
  // Pre-check the head so large stdout chunks skip JSON.parse.
  const head = Buffer.from(buf).subarray(0, Math.min(buf.length, 32)).toString('utf8');
  if (!head.includes('"pairing-wake"')) return false;
  try {
    const msg = JSON.parse(Buffer.from(buf).toString('utf8'));
    return msg && msg.kind === 'pairing-wake';
  } catch {
    return false;
  }
}

function triggerPairingPoll(discoveryKeyHex) {
  const candidate = candidates.get(discoveryKeyHex);
  if (!candidate || typeof candidate._poll !== 'function') return;
  // _poll is fire-and-forget; errors are swallowed inside blind-pairing.
  Promise.resolve(candidate._poll()).catch(() => {});
}

function sendPairingWake(discoveryKeyHex) {
  const entry = execChannels.get(discoveryKeyHex);
  if (!entry?.channel) return false;
  const msg = entry.channel.messages?.[0];
  if (!msg) return false;
  try {
    msg.send(Buffer.from(JSON.stringify({ kind: 'pairing-wake' }), 'utf8'));
    return true;
  } catch (err) {
    console.warn('[peer] pairing-wake send failed:', err?.message ?? err);
    return false;
  }
}

function ensureReady() {
  if (!pairing) throw new Error('peer not initialized; call peer.init first');
}

function getIdentity() {
  if (!identity) return null;
  return {
    publicKey: identity.publicKey,
    createdAt: identity.createdAt ?? null,
  };
}

function finalizePair(discoveryKeyHex, role, userData, autobaseKey, inviteId, hostIdentity) {
  const peerInfo = {
    discoveryKey: discoveryKeyHex,
    sessionPublicKey: null,
    role,
    pairedAt: Date.now(),
    userData,
    autobaseKey: toHex(autobaseKey),
    inviteId: inviteId ?? null,
    hostIdentity: role === 'guest' ? hostIdentity ?? null : null,
  };
  peers.set(discoveryKeyHex, peerInfo);
  appendAudit('peer:paired', {
    discoveryKey: discoveryKeyHex,
    role,
    remoteUserData: userData,
  });
  emit('peer:paired', peerInfo);
  return peerInfo;
}

async function createInvite({ userData = null, autoApprove = false, code = null } = {}) {
  ensureReady();
  const autobaseKey = crypto.randomBytes(32);
  const { invite, publicKey, discoveryKey } = BlindPairing.createInvite(autobaseKey);
  const sessionPublicKey = toHex(publicKey);
  const discoveryKeyHex = toHex(discoveryKey);
  const expectedCode = code || pairingCode.generate();

  const member = pairing.addMember({
    discoveryKey,
    async onadd(candidate) {
      candidate.open(publicKey);
      const remoteUserData = candidate.userData
        ? safeParseJson(Buffer.from(candidate.userData).toString('utf8'))
        : null;
      const inviteIdHex = candidate.inviteId ? toHex(candidate.inviteId) : null;
      const enteredCode = remoteUserData && typeof remoteUserData === 'object'
        ? (remoteUserData.pairingCode ?? null)
        : null;
      const codeMatches = enteredCode && pairingCode.equal(enteredCode, expectedCode);
      const remoteBuildId = remoteUserData && typeof remoteUserData === 'object'
        ? (remoteUserData.buildId ?? null)
        : null;
      const buildVerified = remoteBuildId === BUILD_ID;

      if (!codeMatches) {
        candidate._denied = true;
        appendAudit('peer:rejected', {
          discoveryKey: discoveryKeyHex,
          reason: 'pairing-code-mismatch',
          expected: expectedCode,
          entered: enteredCode,
        });
        await member.close().catch(() => {});
        members.delete(discoveryKeyHex);
        return;
      }

      if (!buildVerified) {
        candidate._denied = true;
        appendAudit('peer:rejected', {
          discoveryKey: discoveryKeyHex,
          reason: 'unverified-build',
        });
        await member.close().catch(() => {});
        members.delete(discoveryKeyHex);
        return;
      }

      if (autoApprove) {
        candidate.confirm({ key: autobaseKey });
        finalizePair(discoveryKeyHex, 'host', remoteUserData, autobaseKey, inviteIdHex);
        return;
      }

      // Already paired with this guest; candidate is a retry or duplicate.
      if (peers.has(discoveryKeyHex)) return;

      if (pendingByDiscovery.has(discoveryKeyHex)) return;
      pendingByDiscovery.add(discoveryKeyHex);

      if (inviteIdHex && pendingByInvite.has(inviteIdHex)) return;
      if (inviteIdHex) pendingByInvite.add(inviteIdHex);

      const requestId = crypto.randomUUID();
      const pending = {
        requestId,
        discoveryKey: discoveryKeyHex,
        sessionPublicKey,
        candidate,
        autobaseKey,
        inviteId: inviteIdHex,
        userData: remoteUserData,
        receivedAt: Date.now(),
        expectedPairingCode: expectedCode,
        enteredPairingCode: enteredCode,
      };
      pendingRequests.set(requestId, pending);
      appendAudit('peer:pending', {
        requestId,
        discoveryKey: discoveryKeyHex,
        remoteUserData,
      });
      emit('peer:pending', {
        requestId,
        discoveryKey: discoveryKeyHex,
        sessionPublicKey,
        inviteId: inviteIdHex,
        userData: remoteUserData,
        receivedAt: pending.receivedAt,
        expectedPairingCode: expectedCode,
        enteredPairingCode: enteredCode,
      });
    },
  });
  await member.flushed();
  members.set(discoveryKeyHex, member);
  attachExecToAllConnections(discoveryKey);

  return {
    invite: Buffer.from(invite).toString('base64'),
    sessionPublicKey,
    discoveryKey: discoveryKeyHex,
    autobaseKey: toHex(autobaseKey),
    userData,
    pairingCode: expectedCode,
    hostIdentity: identity?.publicKey ?? null,
  };
}

async function approve(requestId) {
  const pending = pendingRequests.get(requestId);
  if (!pending) return false;
  pendingRequests.delete(requestId);
  // Keep dedupe entries after approve so the guest's continuous candidate
  // retries don't create a second pending request. Cleared on drop.
  pending.candidate.confirm({ key: pending.autobaseKey });

  // Re-drive the response on the DHT: the member's poll ran onadd before
  // approve, so the peer landed in the skip cache without a response ever put.
  const member = members.get(pending.discoveryKey);
  if (member) {
    try {
      const response = pending.candidate?.response;
      const token = pending.candidate?.token;
      if (response && token) {
        const replyKeyPair = deriveReplyKeyPair(token);
        await member.dht.mutablePut(replyKeyPair, response);
      }
    } catch (err) {
      console.warn('[peer] manual response put failed:', err?.message ?? err);
    }
  }

  // Wake the guest on the exec channel so it polls immediately instead of
  // waiting for the next 30s tick. No-op if the channel isn't open yet.
  sendPairingWake(pending.discoveryKey);

  finalizePair(
    pending.discoveryKey,
    'host',
    pending.userData,
    pending.autobaseKey,
    pending.inviteId,
  );
  appendAudit('peer:approved', { requestId, discoveryKey: pending.discoveryKey });
  return true;
}

async function reject(requestId) {
  const pending = pendingRequests.get(requestId);
  if (!pending) return false;
  pendingRequests.delete(requestId);
  pendingByDiscovery.delete(pending.discoveryKey);
  if (pending.inviteId) pendingByInvite.delete(pending.inviteId);
  pending.candidate._denied = true;
  const member = members.get(pending.discoveryKey);
  if (member) {
    await member.close().catch(() => {});
    members.delete(pending.discoveryKey);
  }
  appendAudit('peer:rejected', { requestId, discoveryKey: pending.discoveryKey });
  emit('peer:rejected', { requestId, discoveryKey: pending.discoveryKey });
  return true;
}

function listPending() {
  return Array.from(pendingRequests.values()).map(({ candidate, ...rest }) => rest);
}

function getAudit({ since = 0, limit = 200 } = {}) {
  const filtered = auditLog.filter((e) => e.timestamp >= since);
  return filtered.slice(-limit);
}

function clearAudit() {
  auditLog.length = 0;
  emit('peer:audit-cleared', { at: Date.now() });
  return true;
}

function clearPeerAudit(discoveryKey) {
  if (typeof discoveryKey !== 'string' || !discoveryKey) {
    throw new Error('clearPeerAudit: discoveryKey is required');
  }
  let removed = 0;
  for (let i = auditLog.length - 1; i >= 0; i--) {
    if (auditLog[i].discoveryKey === discoveryKey) {
      auditLog.splice(i, 1);
      removed += 1;
    }
  }
  emit('peer:audit-cleared-for-peer', { discoveryKey, at: Date.now(), removed });
  return removed;
}

async function acceptInvite(inviteB64, { userData = null, code = null, hostIdentity = null } = {}) {
  ensureReady();
  if (typeof inviteB64 !== 'string' || inviteB64.length === 0) {
    throw new Error('acceptInvite: invite must be a non-empty base64 string');
  }
  const invite = Buffer.from(inviteB64, 'base64');
  const { discoveryKey } = BlindPairing.decodeInvite(invite);
  const discoveryKeyHex = toHex(discoveryKey);

  const localUserData = {
    name: userData?.name || defaultDeviceName(),
    app: 'tether-academy',
    ...(userData ?? {}),
    pairingCode: code || null,
    buildId: BUILD_ID,
  };

  const candidate = pairing.addCandidate({
    invite,
    userData: Buffer.from(JSON.stringify(localUserData), 'utf8'),
    async onadd(result) {
      const keyBuf = result?.key;
      finalizePair(
        discoveryKeyHex,
        'guest',
        localUserData,
        Buffer.isBuffer(keyBuf) ? keyBuf : null,
        null,
        hostIdentity,
      );
    },
  });
  candidates.set(discoveryKeyHex, candidate);
  // Attach the exec protocol to current connections before awaiting pairing
  // so the host's pairing-wake has somewhere to land. No-op if no connection.
  attachExecToAllConnections(discoveryKey);

  appendAudit('peer:pair:sent', { discoveryKey: discoveryKeyHex });

  try {
    await Promise.race([
      candidate.pairing,
      new Promise((_, reject) => {
        const onClose = () => reject(new Error('pairing closed before completion'));
        candidate.once('close', onClose);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('pairing timed out after 30 minutes')), 30 * 60_000)),
    ]);
  } catch (err) {
    candidates.delete(discoveryKeyHex);
    try { await candidate.close(); } catch {}
    appendAudit('peer:pair:error', { discoveryKey: discoveryKeyHex, message: err?.message ?? 'pairing failed' });
    throw err;
  }

  attachExecToAllConnections(discoveryKey);

  return {
    discoveryKey: discoveryKeyHex,
    paired: !!candidate.paired,
  };
}

function listPeers() {
  return Array.from(peers.values());
}

async function dropPeer(discoveryKeyHex) {
  const peer = peers.get(discoveryKeyHex);
  if (!peer) return false;

  const member = members.get(discoveryKeyHex);
  if (member) {
    await member.close().catch(() => {});
    members.delete(discoveryKeyHex);
  }
  const candidate = candidates.get(discoveryKeyHex);
  if (candidate) {
    await candidate.close().catch(() => {});
    candidates.delete(discoveryKeyHex);
  }

  const execState = execStates.get(discoveryKeyHex);
  if (execState?.child && !execState.child.killed) {
    execState.child.kill('SIGTERM');
  }
  execStates.delete(discoveryKeyHex);

  const execCh = execChannels.get(discoveryKeyHex);
  if (execCh?.channel) {
    try { execCh.channel.close(); } catch {}
  }
  execChannels.delete(discoveryKeyHex);

  peers.delete(discoveryKeyHex);
  // Clear dedupe entries that approve() leaves in place so a re-pair isn't blocked.
  pendingByDiscovery.delete(discoveryKeyHex);
  if (peer.inviteId) pendingByInvite.delete(peer.inviteId);
  appendAudit('peer:dropped', { discoveryKey: discoveryKeyHex, role: peer.role });
  emit('peer:dropped', { discoveryKey: discoveryKeyHex });
  return true;
}

function handleExecRequest(discoveryKeyHex, buf) {
  let msg;
  try {
    msg = JSON.parse(Buffer.from(buf).toString('utf8'));
  } catch {
    return;
  }
  if (!msg) return;
  if (msg.kind === 'cancel') {
    const state = execStates.get(discoveryKeyHex);
    if (state?.child && !state.child.killed) {
      state.child.kill('SIGTERM');
      // Native inference ignores SIGTERM; escalate to SIGKILL after 3s.
      setTimeout(() => {
        const s = execStates.get(discoveryKeyHex);
        if (s?.child && !s.child.killed) s.child.kill('SIGKILL');
      }, 3000);
    }
    return;
  }
  if (msg.kind !== 'request') return;
  if (execStates.has(discoveryKeyHex)) {
    const existing = execStates.get(discoveryKeyHex);
    const age = existing?.startedAt ? Date.now() - existing.startedAt : 0;
    // Previous exec alive >5 min means the prior cancel likely didn't take; force-kill and accept.
    if (existing?.child && !existing.child.killed && age > 5 * 60_000) {
      existing.child.kill('SIGKILL');
      // Exit handler tears down state; if state still exists the new exec will queue.
      setTimeout(() => spawnExec(discoveryKeyHex, msg), 100);
      return;
    }
    sendExecReply(discoveryKeyHex, {
      kind: 'error',
      message: 'another exec is already running on this peer',
    });
    return;
  }
  spawnExec(discoveryKeyHex, msg);
}

function handleExecReply(discoveryKeyHex, buf) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(buf).toString('utf8'));
  } catch {
    return;
  }
  if (!payload) return;
  const active = activeGuestExec.get(discoveryKeyHex);
  if (!active) return;
  if (payload.kind === 'started') {
    appendAudit('peer:exec:remote-started', {
      discoveryKey: discoveryKeyHex,
      mode: payload.mode ?? null,
      fileName: payload.fileName ?? null,
    });
  } else if (payload.kind === 'chunk') {
    active.emitter.emit(payload.stream, payload.data);
  } else if (payload.kind === 'exit') {
    active.emitter.emit('exit', { code: payload.code ?? null, signal: payload.signal ?? null });
    active.emitter.emit('end');
    activeGuestExec.delete(discoveryKeyHex);
    appendAudit('peer:exec:remote-finished', {
      discoveryKey: discoveryKeyHex,
      code: payload.code,
      signal: payload.signal ?? null,
      mode: payload.mode ?? null,
      fileName: payload.fileName ?? null,
    });
  } else if (payload.kind === 'error') {
    active.emitter.emit('error', new Error(payload.message ?? 'exec failed'));
    active.emitter.emit('end');
    activeGuestExec.delete(discoveryKeyHex);
    appendAudit('peer:exec:remote-error', {
      discoveryKey: discoveryKeyHex,
      message: payload.message ?? 'exec failed',
      mode: payload.mode ?? null,
      fileName: payload.fileName ?? null,
    });
  }
}

function sendExecReply(discoveryKeyHex, payload) {
  const entry = execChannels.get(discoveryKeyHex);
  if (!entry?.channel) return;
  const msg = entry.channel.messages?.[0];
  if (!msg) return;
  try {
    msg.send(Buffer.from(JSON.stringify(payload), 'utf8'));
  } catch (err) {
    console.warn('[peer] exec reply failed:', err?.message ?? err);
  }
}

function spawnExec(discoveryKeyHex, { code, cwd, mode = 'inline', argv = [], fileName = 'snippet.mts', label = null }) {
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-exec-'));
  const childCwd = cwd && fs.existsSync(cwd) ? cwd : fileDir;
  let args;
  if (mode === 'file') {
    const file = path.join(fileDir, fileName);
    fs.writeFileSync(file, code, 'utf-8');
    args = [...DOCK_HIDE_ARGS, ...argv, file];
  } else {
    args = [...DOCK_HIDE_ARGS, '-e', code, ...argv];
  }
  const child = spawn(process.execPath, args, {
    cwd: childCwd,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  execStates.set(discoveryKeyHex, { child, startedAt: Date.now(), mode, fileName });
  appendAudit('peer:exec:started', { discoveryKey: discoveryKeyHex, mode, fileName, label });
  sendExecReply(discoveryKeyHex, { kind: 'started', mode, fileName, label });

  child.stdout.on('data', (chunk) => {
    sendExecReply(discoveryKeyHex, { kind: 'chunk', stream: 'stdout', data: chunk.toString('utf8') });
  });
  child.stderr.on('data', (chunk) => {
    sendExecReply(discoveryKeyHex, { kind: 'chunk', stream: 'stderr', data: chunk.toString('utf8') });
  });
  child.on('error', (err) => {
    const meta = execStates.get(discoveryKeyHex);
    sendExecReply(discoveryKeyHex, {
      kind: 'error',
      message: err?.message ?? String(err),
      mode: meta?.mode ?? null,
      fileName: meta?.fileName ?? null,
    });
    appendAudit('peer:exec:error', {
      discoveryKey: discoveryKeyHex,
      message: err?.message ?? String(err),
      mode: meta?.mode ?? null,
      fileName: meta?.fileName ?? null,
    });
    execStates.delete(discoveryKeyHex);
  });
  child.on('exit', (code, signal) => {
    const meta = execStates.get(discoveryKeyHex);
    sendExecReply(discoveryKeyHex, {
      kind: 'exit',
      code,
      signal: signal ?? null,
      mode: meta?.mode ?? null,
      fileName: meta?.fileName ?? null,
    });
    appendAudit('peer:exec:finished', {
      discoveryKey: discoveryKeyHex,
      code,
      signal: signal ?? null,
      mode: meta?.mode ?? null,
      fileName: meta?.fileName ?? null,
    });
    execStates.delete(discoveryKeyHex);
  });
}

const activeGuestExec = new Map();

function exec({ peerId, code, cwd = null, mode = 'inline', argv = [], fileName = 'snippet.mts', label = null }) {
  if (typeof peerId !== 'string' || !peerId) {
    throw new Error('exec: peerId is required');
  }
  if (typeof code !== 'string' || !code) {
    throw new Error('exec: code is required');
  }
  if (mode !== 'inline' && mode !== 'file') {
    throw new Error(`exec: mode must be 'inline' or 'file', got ${mode}`);
  }
  if (!Array.isArray(argv)) {
    throw new Error('exec: argv must be an array of strings');
  }
  for (const a of argv) {
    if (typeof a !== 'string') {
      throw new Error('exec: argv entries must be strings');
    }
  }
  if (typeof fileName !== 'string' || !fileName) {
    throw new Error('exec: fileName must be a non-empty string');
  }
  const entry = execChannels.get(peerId);
  if (!entry?.channel) {
    throw new Error(`exec: no exec channel for peer ${peerId.slice(0, 16)}...`);
  }
  const msg = entry.channel.messages?.[0];
  if (!msg) {
    throw new Error('exec: channel has no message slot');
  }
  if (activeGuestExec.has(peerId)) {
    throw new Error('exec: another exec is already running on this peer');
  }
  const emitter = new EventEmitter();
  activeGuestExec.set(peerId, { emitter });
  try {
    msg.send(Buffer.from(JSON.stringify({ kind: 'request', code, cwd, mode, argv, fileName, label }), 'utf8'));
  } catch (err) {
    activeGuestExec.delete(peerId);
    throw err;
  }
  return emitter;
}

function cancelExec(peerId) {
  if (typeof peerId !== 'string' || !peerId) {
    throw new Error('cancelExec: peerId is required');
  }
  if (!activeGuestExec.has(peerId)) return false;
  const entry = execChannels.get(peerId);
  if (!entry?.channel) return false;
  const msg = entry.channel.messages?.[0];
  if (!msg) return false;
  try {
    msg.send(Buffer.from(JSON.stringify({ kind: 'cancel' }), 'utf8'));
    return true;
  } catch (err) {
    console.warn('[peer] cancelExec send failed:', err?.message ?? err);
    return false;
  }
}

async function lockdown() {
  let dropped = 0;
  for (const requestId of Array.from(pendingRequests.keys())) {
    await reject(requestId);
    dropped++;
  }
  for (const discoveryKeyHex of Array.from(peers.keys())) {
    await dropPeer(discoveryKeyHex);
    dropped++;
  }
  appendAudit('peer:lockdown', { dropped });
  return dropped;
}

function on(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function close() {
  for (const m of members.values()) await m.close().catch(() => {});
  for (const c of candidates.values()) await c.close().catch(() => {});
  for (const state of execStates.values()) {
    if (state.child && !state.child.killed) state.child.kill('SIGTERM');
  }
  for (const entry of execChannels.values()) {
    if (entry.channel) {
      try { entry.channel.close(); } catch {}
    }
  }
  members.clear();
  candidates.clear();
  peers.clear();
  pendingRequests.clear();
  execStates.clear();
  execChannels.clear();
  activeGuestExec.clear();
  auditLog.length = 0;
  listeners.clear();
  if (pairing) await pairing.close().catch(() => {});
  if (swarm) await swarm.destroy().catch(() => {});
  pairing = null;
  swarm = null;
  identity = null;
}

module.exports = {
  init,
  getIdentity,
  createInvite,
  approve,
  reject,
  listPending,
  getAudit,
  acceptInvite,
  listPeers,
  dropPeer,
  lockdown,
  exec,
  cancelExec,
  clearAudit,
  clearPeerAudit,
  on,
  close,
};
