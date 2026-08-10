'use strict';

// The worker checks its own command router rather than trusting main. These are
// the payloads that would otherwise destructure undefined inside a handler.

const test = require('brittle');

const CMD = require('../../shared/rpc-commands.cjs');
const { validateCommand, SCHEMAS } = require('../../workers/rpc-schema.cjs');

// Command IDs above this are worker->main pushes; main's router owns those.
const WORKER_TO_MAIN = 100;

const requestCommands = Object.entries(CMD).filter(([, id]) => id < WORKER_TO_MAIN);

test('rpc-schema - every command main can send has a schema', (t) => {
  for (const [name, id] of requestCommands) {
    t.ok(SCHEMAS[id], `${name} (${id}) is unvalidated`);
  }
});

test('rpc-schema - an unknown command is refused rather than routed', (t) => {
  t.exception(() => validateCommand(9999, {}), /no schema/);
});

test('rpc-schema - a missing required field is caught', (t) => {
  t.exception(() => validateCommand(CMD.EXEC, { code: 'x' }), /invalid field "peerId"/);
  t.exception(() => validateCommand(CMD.EXEC, { peerId: 'p' }), /invalid field "code"/);
  t.exception(() => validateCommand(CMD.APPROVE, {}), /invalid field "requestId"/);
  t.exception(() => validateCommand(CMD.DROP_PEER, null), /expected an object/);
});

test('rpc-schema - an empty string is not a valid key or id', (t) => {
  t.exception(() => validateCommand(CMD.CANCEL_EXEC, { peerId: '' }), /invalid field "peerId"/);
  t.exception(() => validateCommand(CMD.CLEAR_PEER_AUDIT, { discoveryKey: '' }), /invalid field/);
});

test('rpc-schema - a field of the wrong type is caught', (t) => {
  t.exception(() => validateCommand(CMD.EXEC, { peerId: 'p', code: 'c', argv: 'ls' }), /"argv"/);
  t.exception(() => validateCommand(CMD.EXEC, { peerId: 'p', code: 'c', argv: [1] }), /"argv"/);
  t.exception(() => validateCommand(CMD.GET_AUDIT, { since: 'yesterday' }), /"since"/);
  t.exception(() => validateCommand(CMD.SET_REVOKED_DEVICES, { keys: [{}] }), /"keys"/);
});

// Either a caller ahead of this worker or a schema behind its handler.
test('rpc-schema - an unexpected field is refused', (t) => {
  t.exception(
    () => validateCommand(CMD.EXEC, { peerId: 'p', code: 'c', cwdEvil: '/' }),
    /unexpected field "cwdEvil"/,
  );
});

test('rpc-schema - valid payloads pass', (t) => {
  t.alike(validateCommand(CMD.EXEC, { peerId: 'p', code: 'c' }), { peerId: 'p', code: 'c' });
  t.alike(
    validateCommand(CMD.EXEC, {
      peerId: 'p',
      code: 'c',
      mode: 'file',
      argv: ['--flag'],
      fileName: 'a.mts',
      label: 'demo',
      cwd: null,
    }).fileName,
    'a.mts',
  );
  t.alike(validateCommand(CMD.LIST_PEERS, {}), {});
  t.alike(validateCommand(CMD.LIST_PEERS, null), {});
  t.alike(validateCommand(CMD.GET_AUDIT, { since: 0, limit: 10 }).limit, 10);
});

// Pins a regression: unrecognized `declared` fields refused the whole
// peer-exec request outright with "invalid field \"declared\"".
test('rpc-schema - declared accepts the fields main actually sends', (t) => {
  const result = validateCommand(CMD.EXEC, {
    peerId: 'p',
    code: 'c',
    declared: { network: 'all', device: ['microphone'], lessonReference: 'ref', rawSource: 'raw' },
  });
  t.alike(result.declared, {
    network: 'all',
    device: ['microphone'],
    lessonReference: 'ref',
    rawSource: 'raw',
  });
  t.exception(
    () => validateCommand(CMD.EXEC, { peerId: 'p', code: 'c', declared: { bogus: 1 } }),
    /invalid field "declared"/,
  );
});

test('rpc-schema - nested payloads are checked, not waved through', (t) => {
  t.exception(
    () => validateCommand(CMD.ACCEPT_INVITE, { inviteB64: 'aGk=', opts: { code: 5 } }),
    /invalid field "opts"/,
  );
  t.exception(
    () => validateCommand(CMD.INIT, { deviceIdentity: { publicKey: 'a' } }),
    /invalid field "deviceIdentity"/,
  );
  t.alike(
    validateCommand(CMD.ACCEPT_INVITE, { inviteB64: 'aGk=', opts: { code: 'abc' } }).opts.code,
    'abc',
  );
});
