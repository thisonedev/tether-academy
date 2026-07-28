const Hyperswarm = require('hyperswarm');
const BlindPairing = require('blind-pairing');
const Protomux = require('protomux');
const c = require('compact-encoding');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pairingCode = require('./pairing-code.cjs');

const AUDIT_CAP = 1000;
const BUILD_ID = 'tether-academy-desktop';
const EXEC_PROTOCOL = 'academy-exec';

const toHex = (buf) => {
  if (buf == null) return null;
  if (typeof buf === 'string') return buf;
  return Buffer.from(buf).toString('hex');
};

const fromHex = (hex) => Buffer.from(hex, 'hex');

let swarm = null;
let pairing = null;
let identity = null;

const members = new Map();
const candidates = new Map();
const peers = new Map();
const pendingRequests = new Map();
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

function attachExecProtocol(mux, discoveryKey) {
  const discoveryKeyHex = toHex(discoveryKey);
  if (execChannels.has(discoveryKeyHex)) return;
  mux.pair({ protocol: EXEC_PROTOCOL, id: discoveryKey }, () => {
    const ch = mux.createChannel({
      protocol: EXEC_PROTOCOL,
      id: discoveryKey,
      messages: [
        { encoding: c.buffer, onmessage: (buf) => routeExecMessage(discoveryKeyHex, buf) },
      ],
    });
    if (!ch) return;
    ch.open();
    execChannels.set(discoveryKeyHex, { channel: ch, mux });
  });
  const ch = mux.createChannel({
    protocol: EXEC_PROTOCOL,
    id: discoveryKey,
    messages: [
      { encoding: c.buffer, onmessage: (buf) => routeExecMessage(discoveryKeyHex, buf) },
    ],
  });
  if (!ch) return;
  ch.open();
  execChannels.set(discoveryKeyHex, { channel: ch, mux });
}

function routeExecMessage(discoveryKeyHex, buf) {
  const peer = peers.get(discoveryKeyHex);
  if (!peer) return;
  if (peer.role === 'host') {
    handleExecRequest(discoveryKeyHex, buf);
  } else {
    handleExecReply(discoveryKeyHex, buf);
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
  pending.candidate.confirm({ key: pending.autobaseKey });
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

async function acceptInvite(inviteB64, { userData = null, code = null, hostIdentity = null } = {}) {
  ensureReady();
  if (typeof inviteB64 !== 'string' || inviteB64.length === 0) {
    throw new Error('acceptInvite: invite must be a non-empty base64 string');
  }
  const invite = Buffer.from(inviteB64, 'base64');
  const { discoveryKey } = BlindPairing.decodeInvite(invite);
  const discoveryKeyHex = toHex(discoveryKey);

  const localUserData = {
    ...(userData ?? { name: os.hostname(), app: 'tether-academy' }),
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

  await candidate.pairing;

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
    }
    return;
  }
  if (msg.kind !== 'request') return;
  if (execStates.has(discoveryKeyHex)) {
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
  if (payload.kind === 'chunk') {
    active.emitter.emit(payload.stream, payload.data);
  } else if (payload.kind === 'exit') {
    active.emitter.emit('exit', { code: payload.code ?? null, signal: payload.signal ?? null });
    active.emitter.emit('end');
    activeGuestExec.delete(discoveryKeyHex);
  } else if (payload.kind === 'error') {
    active.emitter.emit('error', new Error(payload.message ?? 'exec failed'));
    active.emitter.emit('end');
    activeGuestExec.delete(discoveryKeyHex);
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

function spawnExec(discoveryKeyHex, { code, cwd, mode = 'inline', argv = [], fileName = 'snippet.mts' }) {
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-exec-'));
  const childCwd = cwd && fs.existsSync(cwd) ? cwd : fileDir;
  let args;
  if (mode === 'file') {
    const file = path.join(fileDir, fileName);
    fs.writeFileSync(file, code, 'utf-8');
    args = [...argv, file];
  } else {
    args = ['-e', code, ...argv];
  }
  const child = spawn(process.execPath, args, {
    cwd: childCwd,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  execStates.set(discoveryKeyHex, { child });
  appendAudit('peer:exec:started', { discoveryKey: discoveryKeyHex, mode, fileName });

  child.stdout.on('data', (chunk) => {
    sendExecReply(discoveryKeyHex, { kind: 'chunk', stream: 'stdout', data: chunk.toString('utf8') });
  });
  child.stderr.on('data', (chunk) => {
    sendExecReply(discoveryKeyHex, { kind: 'chunk', stream: 'stderr', data: chunk.toString('utf8') });
  });
  child.on('error', (err) => {
    sendExecReply(discoveryKeyHex, { kind: 'error', message: err?.message ?? String(err) });
    appendAudit('peer:exec:error', { discoveryKey: discoveryKeyHex, message: err?.message ?? String(err) });
    execStates.delete(discoveryKeyHex);
  });
  child.on('exit', (code, signal) => {
    sendExecReply(discoveryKeyHex, { kind: 'exit', code, signal: signal ?? null });
    appendAudit('peer:exec:finished', { discoveryKey: discoveryKeyHex, code, signal: signal ?? null });
    execStates.delete(discoveryKeyHex);
  });
}

const activeGuestExec = new Map();

function exec({ peerId, code, cwd = null, mode = 'inline', argv = [], fileName = 'snippet.mts' }) {
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
    msg.send(Buffer.from(JSON.stringify({ kind: 'request', code, cwd, mode, argv, fileName }), 'utf8'));
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
  on,
  close,
};
