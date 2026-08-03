'use strict';

// Direct coverage for the extracted verification + revocation factories.
// The end-to-end trust flows still live in tests/integration/*, which exercise
// the same wiring through index.cjs; this file pins the factory contracts.

const test = require('brittle');

const {
  createVerification,
  createRevocation,
} = require('../../workers/peer/verification.cjs');

function makeStubAudit() {
  const log = [];
  const appendAudit = (type, payload) => log.push({ type, ...payload });
  return { log, appendAudit };
}

function makeStubEmitters() {
  const events = [];
  const emit = (event, payload) => events.push({ event, payload });
  return { events, emit };
}

function makeIdentityHandshakeStub() {
  return {
    HELLO_KIND: 'identity-hello',
    PROOF_KIND: 'identity-proof',
    buildProofReply: (_dk, nonce, keyPair) => ({
      kind: 'identity-proof',
      nonce,
      signature: keyPair?.secretKey ? 'sig' : 'unsigned',
    }),
    verifyProofReply: (msg, { nonce }) => msg.signature === 'sig' && msg.nonce === nonce,
    readHello: (msg) => ({
      nonce: msg.nonce,
      devicePublicKey: msg.devicePublicKey,
      identityPublicKey: msg.identityPublicKey ?? null,
      identityProven: !!msg.identityPublicKey,
    }),
  };
}

function makeContext() {
  const peers = new Map();
  const identitySessions = new Map();
  const { log: auditLog, appendAudit } = makeStubAudit();
  const { events, emit } = makeStubEmitters();
  const sent = [];
  const dropped = [];
  const identityHandshake = makeIdentityHandshakeStub();
  // Mutable so a test can wire the factory before the keypair exists, which is
  // the order init() uses.
  let signingKeyPair = { secretKey: Buffer.alloc(64) };
  const setSigningKeyPair = (kp) => {
    signingKeyPair = kp;
  };
  const sendIdentityFrame = (_dk, frame) => sent.push(frame);
  const isRevokedDevice = (key) => key === 'revoked-key';
  const dropPeer = async (dk) => {
    dropped.push(dk);
    peers.delete(dk);
  };
  return {
    peers,
    identitySessions,
    appendAudit,
    emit,
    events,
    sent,
    dropped,
    auditLog,
    identityHandshake,
    getSigningKeyPair: () => signingKeyPair,
    setSigningKeyPair,
    sendIdentityFrame,
    isRevokedDevice,
    dropPeer,
  };
}

function makeSession(dk, { devicePublicKey = 'device-a', identityPublicKey = null } = {}) {
  return {
    nonce: 'n',
    remote: { nonce: 'n', devicePublicKey, identityPublicKey, identityProven: !!identityPublicKey },
    deviceVerified: true,
    applied: false,
  };
}

function makePeer(dk, overrides = {}) {
  return {
    discoveryKey: dk,
    role: 'host',
    userData: {},
    verifiedDevicePublicKey: null,
    verifiedIdentityPublicKey: null,
    identityVerified: false,
    ...overrides,
  };
}

test('verification - claimMatches accepts a device key', (t) => {
  const ctx = makeContext();
  const v = createVerification(ctx);
  const remote = { devicePublicKey: 'a', identityPublicKey: 'i', identityProven: true };
  t.is(v.claimMatches('a', remote), true);
  t.is(v.claimMatches('i', remote), true);
  t.is(v.claimMatches('o', remote), false);
});

test('verification - claimMatches rejects an identity key when not proven', (t) => {
  const ctx = makeContext();
  const v = createVerification(ctx);
  const remote = { devicePublicKey: 'a', identityPublicKey: 'i', identityProven: false };
  t.is(v.claimMatches('i', remote), false);
});

test('verification - peerVerification reports no-peer before the pair exists', (t) => {
  const ctx = makeContext();
  const v = createVerification(ctx);
  t.alike(v.peerVerification('missing'), { ok: false, reason: 'no-peer' });
});

test('verification - peerVerification reports pending before the proof lands', (t) => {
  const ctx = makeContext();
  const dk = '00'.repeat(32);
  ctx.peers.set(dk, makePeer(dk));
  const v = createVerification(ctx);
  t.alike(v.peerVerification(dk), { ok: false, reason: 'pending' });
});

test('verification - peerVerification flags device-key-mismatch after proof', (t) => {
  const ctx = makeContext();
  const dk = 'aa'.repeat(32);
  ctx.peers.set(dk, makePeer(dk, {
    userData: { devicePublicKey: 'borrowed' },
    verifiedDevicePublicKey: 'real',
  }));
  const v = createVerification(ctx);
  t.alike(v.peerVerification(dk), { ok: false, reason: 'device-key-mismatch' });
});

// init() wires this factory before it derives the keypair, and close() drops
// the keypair again. Reading it per frame is what keeps the reply signed.
test('verification - the proof reply reads the keypair at frame time', (t) => {
  const ctx = makeContext();
  const dk = 'cc'.repeat(32);
  ctx.peers.set(dk, makePeer(dk));
  ctx.identitySessions.set(dk, { nonce: 'n', remote: null, deviceVerified: false, applied: false });
  ctx.setSigningKeyPair(null);
  const v = createVerification(ctx);

  v.handleIdentityFrame(dk, { kind: 'identity-hello', nonce: 'n', devicePublicKey: 'device-a' });
  t.is(ctx.sent.length, 0, 'no reply is sent while the keypair is missing');

  ctx.setSigningKeyPair({ secretKey: Buffer.alloc(64) });
  v.handleIdentityFrame(dk, { kind: 'identity-hello', nonce: 'n', devicePublicKey: 'device-a' });
  t.is(ctx.sent.length, 1);
  t.is(ctx.sent[0].signature, 'sig', 'the reply is signed with the derived keypair');
});

test('verification - handleIdentityFrame drops a peer whose device key is revoked', async (t) => {
  const ctx = makeContext();
  const dk = 'bb'.repeat(32);
  ctx.peers.set(dk, makePeer(dk));
  ctx.identitySessions.set(dk, makeSession(dk, { devicePublicKey: 'revoked-key' }));
  const v = createVerification(ctx);
  v.handleIdentityFrame(dk, { kind: ctx.identityHandshake.PROOF_KIND, nonce: 'n', signature: 'sig' });
  await new Promise((r) => setImmediate(r));
  t.is(ctx.dropped.length, 1, 'the revoked peer is dropped');
  t.ok(
    ctx.auditLog.some((e) => e.type === 'peer:rejected' && e.reason === 'device-revoked'),
    'the rejection is audited',
  );
});

test('verification - settleVerificationWaiters wakes parked callers with the current state', async (t) => {
  const ctx = makeContext();
  const dk = 'cc'.repeat(32);
  ctx.peers.set(dk, makePeer(dk, { verifiedDevicePublicKey: 'a' }));
  const v = createVerification(ctx);
  // Park the caller on a peer that's still pending first.
  const pending = 'dd'.repeat(32);
  ctx.peers.set(pending, makePeer(pending));
  const parked = v.awaitPeerVerification(pending, 1000);
  // Promote the peer and wake the parked caller so the promise resolves.
  ctx.peers.get(pending).verifiedDevicePublicKey = 'a';
  v.settleVerificationWaiters(pending);
  // The waiter resolves through settleVerificationWaiters's for-loop, which
  // runs synchronously inside the call; the .then() observer fires in the next
  // microtask, so one tick is enough for the value to land.
  const observed = await parked;
  t.alike(observed, { ok: true, reason: null });
});

test('verification - awaitPeerVerification resolves to timeout when the handshake never settles', async (t) => {
  const ctx = makeContext();
  const dk = 'ee'.repeat(32);
  ctx.peers.set(dk, makePeer(dk));
  const v = createVerification(ctx);
  // The internal handshake timer calls .unref() so it cannot keep the loop
  // alive by itself — a deliberate choice so a stuck handshake never pins the
  // process. In tests that means Node would otherwise fire beforeExit before
  // the timer has a chance to elapse, which brittle reads as a deadlock. A
  // ref'd keeper timer holds the loop open for the test's duration.
  const keeper = setTimeout(() => {}, 500);
  try {
    const result = await v.awaitPeerVerification(dk, 50);
    t.alike(result, { ok: false, reason: 'timeout' });
  } finally {
    clearTimeout(keeper);
  }
});

test('verification - settleAllWaiters drains every parked caller', async (t) => {
  const ctx = makeContext();
  const a = '11'.repeat(32);
  const b = '22'.repeat(32);
  ctx.peers.set(a, makePeer(a));
  ctx.peers.set(b, makePeer(b));
  const v = createVerification(ctx);
  const aParked = v.awaitPeerVerification(a, 1000);
  const bParked = v.awaitPeerVerification(b, 1000);
  v.settleAllWaiters();
  const [aSettled, bSettled] = await Promise.all([aParked, bParked]);
  // Parked callers each get the current peerVerification state; both peers
  // here are pending (no verifiedDevicePublicKey yet), so the wake reports
  // `pending` rather than the no-peer reason a fresh peer would.
  t.alike(aSettled, { ok: false, reason: 'pending' });
  t.alike(bSettled, { ok: false, reason: 'pending' });
});

test('revocation - setRevokedDevices drops already-paired revoked devices', async (t) => {
  const peers = new Map();
  const pendingRequests = new Map();
  const { appendAudit } = makeStubAudit();
  const dropped = [];
  const rejected = [];
  const dropPeer = async (dk) => { dropped.push(dk); peers.delete(dk); };
  const reject = async (id) => { rejected.push(id); };
  const r = createRevocation({ peers, pendingRequests, appendAudit, dropPeer, reject });

  peers.set('dk1', makePeer('dk1', { verifiedDevicePublicKey: 'bad' }));
  peers.set('dk2', makePeer('dk2', { verifiedDevicePublicKey: 'good' }));

  const result = r.setRevokedDevices(['bad']);
  await new Promise((r) => setImmediate(r));

  t.is(result.revoked, 1);
  t.is(result.dropped, 1, 'only the revoked peer is dropped');
  t.alike(dropped, ['dk1']);
});

test('revocation - setRevokedDevices withdraws pending requests that claim a revoked key', async (t) => {
  const peers = new Map();
  const pendingRequests = new Map();
  const { appendAudit } = makeStubAudit();
  const dropped = [];
  const rejected = [];
  const dropPeer = async (dk) => { dropped.push(dk); };
  const reject = async (id) => { rejected.push(id); };
  const r = createRevocation({ peers, pendingRequests, appendAudit, dropPeer, reject });

  pendingRequests.set('req-1', { userData: { devicePublicKey: 'bad' } });
  pendingRequests.set('req-2', { userData: { devicePublicKey: 'good' } });

  r.setRevokedDevices(['bad']);
  await new Promise((r) => setImmediate(r));

  t.alike(rejected, ['req-1'], 'only the revoked request is withdrawn');
  t.is(dropped.length, 0, 'no peers to drop');
});

test('revocation - isRevokedDevice respects the most recent set', (t) => {
  const peers = new Map();
  const pendingRequests = new Map();
  const { appendAudit } = makeStubAudit();
  const r = createRevocation({
    peers,
    pendingRequests,
    appendAudit,
    dropPeer: async () => {},
    reject: async () => {},
  });

  t.is(r.isRevokedDevice('a'), false);
  r.setRevokedDevices(['a']);
  t.is(r.isRevokedDevice('a'), true);
  r.setRevokedDevices([]);
  t.is(r.isRevokedDevice('a'), false);
});
