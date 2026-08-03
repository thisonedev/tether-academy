// Main-process proxy for the pear-end Bare worker. Drop-in match for
// peer.cjs's old exported shape (init, getIdentity, createInvite, ...,
// exec, on, close) so pear-end/index.cjs's `peer` swap is one line.
// Plus shutdownWorker(), new here: killing the actual worker process is a
// distinct operation from close()/CMD.CLOSE (mesh teardown only, matching
// peer.cjs's original close() semantics, used by academy:identity:reset,
// where the worker should stay alive for a future re-init).
const path = require('path');
const PearRuntime = require('pear-runtime');
const RPC = require('bare-rpc');
const { EventEmitter } = require('events');
const CMD = require('../../shared/rpc-commands.cjs');
const { resolveBareBin } = require('../../shared/bare-bin.cjs');

const WORKER_ENTRY = require.resolve('../../workers/entry.cjs');
const SHUTDOWN_TIMEOUT_MS = 5000;

let worker = null;
let rpc = null;
const listeners = new Set();
const pendingExec = new Map(); // peerId -> EventEmitter

function emit(event, payload) {
  for (const listener of listeners) {
    try {
      listener(event, payload);
    } catch (err) {
      console.warn('[worker-client] listener error:', err?.message ?? err);
    }
  }
}

function toJson(value) {
  return Buffer.from(JSON.stringify(value === undefined ? null : value), 'utf8');
}
function fromJson(data) {
  return data && data.length ? JSON.parse(data.toString('utf8')) : null;
}
function unwrap(res) {
  if (!res || !res.ok) {
    throw new Error((res && res.error && res.error.message) || 'pear-end worker error');
  }
  return res.result;
}

async function call(command, args) {
  if (!rpc) throw new Error('worker-client: not initialized');
  const req = rpc.request(command);
  req.send(toJson(args));
  const data = await req.reply();
  return unwrap(fromJson(data));
}

function buildMainRouter() {
  const router = new RPC.CommandRouter();
  router.respond(CMD.PEER_EVENT, (_req, data) => {
    const { event, payload } = fromJson(data);
    emit(event, payload);
    return toJson({ ok: true });
  });
  router.respond(CMD.EXEC_CHUNK, (_req, data) => {
    const { peerId, stream, data: chunk } = fromJson(data);
    pendingExec.get(peerId)?.emit(stream, chunk);
    return toJson({ ok: true });
  });
  router.respond(CMD.EXEC_EXIT, (_req, data) => {
    const { peerId, info } = fromJson(data);
    const emitter = pendingExec.get(peerId);
    pendingExec.delete(peerId);
    emitter?.emit('exit', info);
    return toJson({ ok: true });
  });
  router.respond(CMD.EXEC_ERROR, (_req, data) => {
    const { peerId, error } = fromJson(data);
    const emitter = pendingExec.get(peerId);
    pendingExec.delete(peerId);
    emitter?.emit('error', new Error(error?.message || 'exec error'));
    return toJson({ ok: true });
  });
  return router;
}

async function init({
  store,
  bootstrap = null,
  deviceIdentity = null,
  execPath = null,
  secretScheme = null,
  attestation = null,
  revokedDevices = null,
  auditPath = null,
}) {
  if (!rpc) {
    worker = PearRuntime.run(WORKER_ENTRY, []);
    worker.stderr.on('data', (d) => console.warn('[pear-end worker]', d.toString('utf8')));
    worker.once('exit', (code) => {
      if (code) console.warn('[pear-end worker] exited unexpectedly, code=', code);
      rpc = null;
      worker = null;
      for (const emitter of pendingExec.values()) {
        emitter.emit('error', new Error('pear-end worker exited'));
      }
      pendingExec.clear();
    });
    rpc = new RPC(worker, buildMainRouter());
  }
  const bareRuntimeBinPath = resolveBareBin();
  return call(CMD.INIT, {
    deviceIdentity,
    bootstrap,
    execPath: execPath || process.execPath,
    bareRuntimeBinPath,
    secretScheme,
    attestation,
    revokedDevices,
    auditPath,
  });
}

async function getIdentity() {
  return call(CMD.GET_IDENTITY, {});
}
async function createInvite(opts) {
  return call(CMD.CREATE_INVITE, opts ?? {});
}
async function approve(requestId) {
  return call(CMD.APPROVE, { requestId });
}
async function reject(requestId) {
  return call(CMD.REJECT, { requestId });
}
async function listPending() {
  return call(CMD.LIST_PENDING, {});
}
async function resolveDeviceRequest(requestId, approved) {
  return call(CMD.RESOLVE_DEVICE_REQUEST, { requestId, approved });
}
async function listDeviceRequests() {
  return call(CMD.LIST_DEVICE_REQUESTS, {});
}
async function getAudit(opts) {
  return call(CMD.GET_AUDIT, opts ?? {});
}
async function acceptInvite(inviteB64, opts) {
  return call(CMD.ACCEPT_INVITE, { inviteB64, opts: opts ?? {} });
}
async function listPeers() {
  return call(CMD.LIST_PEERS, {});
}
async function dropPeer(discoveryKeyHex) {
  return call(CMD.DROP_PEER, { discoveryKeyHex });
}
async function setRevokedDevices(keys) {
  return call(CMD.SET_REVOKED_DEVICES, { keys });
}
async function lockdown() {
  return call(CMD.LOCKDOWN, {});
}
async function cancelExec(peerId) {
  return call(CMD.CANCEL_EXEC, { peerId });
}
async function clearAudit() {
  return call(CMD.CLEAR_AUDIT, {});
}
async function clearPeerAudit(discoveryKey) {
  return call(CMD.CLEAR_PEER_AUDIT, { discoveryKey });
}

// Synchronous-return contract matches peer.cjs's original exec(): returns
// an EventEmitter immediately (or throws). Since the real call is now async
// RPC, dispatch-time failures are delivered as a deferred 'error' event
// instead of a synchronous throw; main.js's academy:run handler already
// treats both identically (resolves {ok:false, output:...}).
function exec(args) {
  const emitter = new EventEmitter();
  const { peerId } = args;
  if (!rpc) {
    queueMicrotask(() => emitter.emit('error', new Error('worker-client: not initialized')));
    return emitter;
  }
  pendingExec.set(peerId, emitter);
  const req = rpc.request(CMD.EXEC);
  req.send(toJson(args));
  req
    .reply()
    .then((data) => {
      const res = fromJson(data);
      if (!res.ok) {
        pendingExec.delete(peerId);
        emitter.emit('error', new Error(res.error?.message || 'exec failed'));
      }
      // else: worker-pushed EXEC_CHUNK/EXEC_EXIT/EXEC_ERROR drive the rest.
    })
    .catch((err) => {
      pendingExec.delete(peerId);
      emitter.emit('error', err);
    });
  return emitter;
}

function on(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Mesh teardown only, mirrors peer.cjs's original close(). Worker process
// stays alive so a later init() can re-init in place (academy:identity:reset).
async function close() {
  if (!rpc) return;
  await call(CMD.CLOSE, {});
}

// Full worker-process termination, for app quit. Not part of peer.cjs's
// original surface; pear-end/index.cjs's shutdown() calls this instead of
// close() so the worker OS process actually exits, not just the mesh state.
async function shutdownWorker() {
  if (!rpc || !worker) return;
  const w = worker;
  try {
    await Promise.race([
      call(CMD.SHUTDOWN, {}),
      new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown timeout')), SHUTDOWN_TIMEOUT_MS)),
    ]);
  } catch (err) {
    console.warn('[worker-client] graceful shutdown failed, force-killing:', err?.message ?? err);
  }
  // Always force-kill too: cheap and idempotent (destroy() on an already-
  // dead process no-ops), and the graceful path above may have timed out.
  try {
    w.destroy();
  } catch {
    // already gone
  }
  rpc = null;
  worker = null;
  pendingExec.clear();
  listeners.clear();
}

module.exports = {
  init,
  getIdentity,
  createInvite,
  approve,
  reject,
  listPending,
  resolveDeviceRequest,
  listDeviceRequests,
  getAudit,
  acceptInvite,
  listPeers,
  dropPeer,
  setRevokedDevices,
  lockdown,
  exec,
  cancelExec,
  clearAudit,
  clearPeerAudit,
  on,
  close,
  shutdownWorker,
};
