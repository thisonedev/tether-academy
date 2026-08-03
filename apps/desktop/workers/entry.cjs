// Pear-end worker entry. Runs under real Bare (spawned via PearRuntime.run()
// from worker-client.cjs), never under Node/Electron. Owns peer.cjs (pairing,
// swarm, exec orchestration) behind a bare-rpc command router.
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
 * Register a handler behind its own shape check. Everything here has already
 * passed main's schema; checked again because that is an assumption, not a check.
 * The 'rpc:command' row in the rate limiter is a runaway-loop backstop on
 * the worker channel: these calls originate from main, are human-driven, and
 * share one global budget so a single hung UI cannot pin the worker.
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

// peerId -> in-flight guest-side exec, so EXEC_* pushes can't be confused
// with a later, unrelated exec on the same peer.
const pendingRunIds = new Map();

function pushRequest(command, payload) {
  if (!rpc) return;
  const req = rpc.request(command);
  req.send(toJson(payload));
  // Fire-and-forget from the worker's side; main always replies to ack.
  req.reply().catch(() => {});
}

// One subscription per process. A second listener pushes every peer event to
// main twice, and main fans events out to a renderer that reloads its lists on
// each one.
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
  });
  if (!eventsBound) {
    eventsBound = true;
    peer.on((event, payload) => pushRequest(CMD.PEER_EVENT, { event, payload }));
  }
  return toJson({ ok: true });
});

respond(CMD.SHUTDOWN, async () => {
  await peer.close();
  // No self-exit here: worker-client.cjs always calls worker.destroy() after
  // this ack (success or not), which kills the process from the outside.
  // Self-exiting here raced the ack write against process termination.
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
