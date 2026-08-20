// Pear-end worker entry. Runs under real Bare, never Node/Electron. Owns
// peer.cjs (pairing, swarm, exec orchestration) behind a bare-rpc command router.
const RPC = require('bare-rpc');
const peer = require('./peer/index.cjs');
const CMD = require('../shared/rpc-commands.cjs');
const { validateCommand } = require('./rpc-schema.cjs');
const { isAllowed: rpcAllow } = require('./peer/rate-limit.cjs');

function toJson(value) {
  return Buffer.from(JSON.stringify(value === undefined ? null : value), 'utf8');
}
function fromJson(data) {
  return data && data.length ? JSON.parse(data.toString('utf8')) : null;
}
function errBody(err) {
  return { message: err && err.message ? err.message : String(err) };
}
// @ts-ignore - bare-rpc's .d.ts omits CommandRouter; the runtime exports it.
const router = new RPC.CommandRouter();
let rpc = null;

/**
 * @param {number} command
 * @param {(args: object) => unknown} handler
 */
function respond(command, handler) {
  router.respond(command, async (_req, data) => {
    if (!rpcAllow('rpc:command', '__global__')) {
      console.warn('[worker] rpc:command rate-limited');
      return toJson({ ok: false, error: { message: 'rate-limited' } });
    }
    let args;
    try {
      args = validateCommand(command, fromJson(data));
    } catch (err) {
      console.warn('[worker]', err.message);
      return toJson({ ok: false, error: errBody(err) });
    }
    return handler(args);
  });
}

// peerId -> in-flight guest-side exec.
const pendingRunIds = new Map();

function pushRequest(command, payload) {
  if (!rpc) return;
  const req = rpc.request(command);
  req.send(toJson(payload));
  // Fire-and-forget from the worker's side; main always replies to ack.
  req.reply().catch(() => {});
}

// Unlike pushRequest, this awaits and returns main's actual reply. Used
// where the worker needs a real result back, not just an ack.
async function requestFromMain(command, payload) {
  if (!rpc) throw new Error('worker: rpc not initialized');
  const req = rpc.request(command);
  req.send(toJson(payload));
  const res = fromJson(await req.reply());
  if (!res || !res.ok) throw new Error((res && res.error && res.error.message) || 'main request failed');
  return res.result;
}

// Passed into peer.init() so exec-host.cjs's security scan (running under
// Bare, no access to electron/chat.cjs) can reach the real model call on main.
function runSecurityScanViaMain(payload) {
  return requestFromMain(CMD.SECURITY_SCAN, payload);
}

// Same reason as the scan above: fetching a model needs https, which Bare
// does not have.
function fetchModelsViaMain(payload) {
  return requestFromMain(CMD.FETCH_MODELS, payload);
}

// One subscription per process; a second listener would push every peer event to main twice.
let eventsBound = false;

respond(CMD.INIT, async (args) => {
  await peer.init({
    store: null,
    deviceIdentity: args.deviceIdentity,
    bootstrap: args.bootstrap ?? null,
    execPath: args.execPath ?? null,
    bareRuntimeBinPath: args.bareRuntimeBinPath ?? null,
    secretScheme: args.secretScheme ?? null,
    attestation: args.attestation ?? null,
    revokedDevices: args.revokedDevices ?? null,
    auditPath: args.auditPath ?? null,
    runSecurityScan: runSecurityScanViaMain,
    fetchModels: fetchModelsViaMain,
  });
  if (!eventsBound) {
    eventsBound = true;
    peer.on((event, payload) => pushRequest(CMD.PEER_EVENT, { event, payload }));
  }
  return toJson({ ok: true });
});

respond(CMD.SHUTDOWN, async () => {
  await peer.close();
  // No self-exit: worker-client.cjs calls worker.destroy() after this ack,
  // which raced the ack write when done here instead.
  return toJson({ ok: true });
});

respond(CMD.GET_IDENTITY, async () => {
  return toJson({ ok: true, result: peer.getIdentity() });
});

respond(CMD.CREATE_INVITE, async (args) => {
  try {
    const result = await peer.createInvite(args);
    return toJson({ ok: true, result });
  } catch (err) {
    return toJson({ ok: false, error: errBody(err) });
  }
});

respond(CMD.APPROVE, async ({ requestId }) => {
  return toJson({ ok: true, result: await peer.approve(requestId) });
});

respond(CMD.REJECT, async ({ requestId }) => {
  return toJson({ ok: true, result: await peer.reject(requestId) });
});

respond(CMD.LIST_PENDING, async () => {
  return toJson({ ok: true, result: peer.listPending() });
});

respond(CMD.RESOLVE_DEVICE_REQUEST, async ({ requestId, approved }) => {
  return toJson({ ok: true, result: peer.resolveDeviceRequest(requestId, approved) });
});

respond(CMD.LIST_DEVICE_REQUESTS, async () => {
  return toJson({ ok: true, result: peer.listDeviceRequests() });
});

respond(CMD.GET_AUDIT, async (args) => {
  return toJson({ ok: true, result: peer.getAudit(args) });
});

respond(CMD.ACCEPT_INVITE, async ({ inviteB64, opts }) => {
  try {
    const result = await peer.acceptInvite(inviteB64, opts || {});
    return toJson({ ok: true, result });
  } catch (err) {
    return toJson({ ok: false, error: errBody(err) });
  }
});

respond(CMD.LIST_PEERS, async () => {
  return toJson({ ok: true, result: peer.listPeers() });
});

respond(CMD.DROP_PEER, async ({ discoveryKeyHex }) => {
  return toJson({ ok: true, result: await peer.dropPeer(discoveryKeyHex) });
});

respond(CMD.SET_REVOKED_DEVICES, async ({ keys }) => {
  return toJson({ ok: true, result: peer.setRevokedDevices(keys) });
});

respond(CMD.LOCKDOWN, async () => {
  return toJson({ ok: true, result: await peer.lockdown() });
});

respond(CMD.EXEC, async (args) => {
  const { peerId } = args;
  try {
    const emitter = peer.exec(args);
    pendingRunIds.set(peerId, true);
    emitter.on('stdout', (chunk) => pushRequest(CMD.EXEC_CHUNK, { peerId, stream: 'stdout', data: chunk }));
    emitter.on('stderr', (chunk) => pushRequest(CMD.EXEC_CHUNK, { peerId, stream: 'stderr', data: chunk }));
    emitter.on('exit', (info) => {
      pendingRunIds.delete(peerId);
      pushRequest(CMD.EXEC_EXIT, { peerId, info });
    });
    emitter.on('error', (err) => {
      pendingRunIds.delete(peerId);
      pushRequest(CMD.EXEC_ERROR, { peerId, error: errBody(err) });
    });
    return toJson({ ok: true });
  } catch (err) {
    return toJson({ ok: false, error: errBody(err) });
  }
});

respond(CMD.CANCEL_EXEC, async ({ peerId }) => {
  return toJson({ ok: true, result: peer.cancelExec(peerId) });
});

respond(CMD.CLEAR_AUDIT, async () => {
  return toJson({ ok: true, result: peer.clearAudit() });
});

respond(CMD.CLEAR_PEER_AUDIT, async ({ discoveryKey }) => {
  return toJson({ ok: true, result: peer.clearPeerAudit(discoveryKey) });
});

respond(CMD.CLOSE, async () => {
  const result = await peer.close();
  // close() drops the listener set, so the next INIT has to subscribe again.
  eventsBound = false;
  return toJson({ ok: true, result });
});

// @ts-ignore - bare-rpc's .d.ts uses `export =` and the upstream class has no
// construct signature in the type stub; the runtime accepts the same shape.
rpc = new RPC(Bare.IPC, router);
