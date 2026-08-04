// Shape checks for every command the worker accepts over bare-rpc. Deliberately
// not the Zod schemas main uses, since sharing them would make both ends agree
// by construction. Plain JS, no dependency, since this runs under Bare.
'use strict';

const CMD = require('../shared/rpc-commands.cjs');

const isString = (v) => typeof v === 'string';
const isBoolean = (v) => typeof v === 'boolean';
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** Anything JSON can carry: `userData` is a peer's own label. */
const isAny = () => true;

const nonEmptyString = (v) => isString(v) && v.length > 0;
const arrayOf = (check) => (v) => Array.isArray(v) && v.every(check);

const optional = (check) => (v) => v == null || check(v);

/** @param {Record<string, (v: unknown) => boolean>} fields */
function object(fields) {
  return (value) => {
    if (!isPlainObject(value)) return 'expected an object';
    for (const key of Object.keys(value)) {
      if (!(key in fields)) return `unexpected field "${key}"`;
    }
    for (const [key, check] of Object.entries(fields)) {
      if (!check(value[key])) return `invalid field "${key}"`;
    }
    return null;
  };
}

/** Commands that take no arguments still get `{}` from the client. */
const noArgs = (value) => (value == null || isPlainObject(value) ? null : 'expected no arguments');

const deviceIdentity = object({
  publicKey: nonEmptyString,
  privateKey: nonEmptyString,
  secretKey: nonEmptyString,
  createdAt: optional(isNumber),
  identityPublicKey: optional(isString),
  source: optional(isString),
});

const attestation = object({
  proof: nonEmptyString,
  identityPublicKey: nonEmptyString,
  devicePublicKey: nonEmptyString,
});

const nested = (schema) => (v) => v == null || schema(v) === null;

const SCHEMAS = {
  [CMD.INIT]: object({
    deviceIdentity: nested(deviceIdentity),
    bootstrap: optional(arrayOf(isAny)),
    execPath: optional(isString),
    bareRuntimeBinPath: optional(isString),
    secretScheme: optional(isString),
    attestation: nested(attestation),
    revokedDevices: optional(arrayOf(isString)),
    store: optional(isAny),
    // Resolved by main against app.getPath('userData').
    auditPath: optional(isString),
  }),
  [CMD.SHUTDOWN]: noArgs,
  [CMD.GET_IDENTITY]: noArgs,
  [CMD.CREATE_INVITE]: object({
    userData: optional(isAny),
    // Test-only on the peer side; main never forwards either.
    autoApprove: optional(isBoolean),
    code: optional(isString),
  }),
  [CMD.APPROVE]: object({ requestId: nonEmptyString }),
  [CMD.REJECT]: object({ requestId: nonEmptyString }),
  [CMD.LIST_PENDING]: noArgs,
  [CMD.RESOLVE_DEVICE_REQUEST]: object({
    requestId: nonEmptyString,
    approved: optional(isBoolean),
  }),
  [CMD.LIST_DEVICE_REQUESTS]: noArgs,
  [CMD.GET_AUDIT]: object({
    since: optional(isNumber),
    limit: optional(isNumber),
  }),
  [CMD.ACCEPT_INVITE]: object({
    inviteB64: nonEmptyString,
    opts: nested(
      object({
        userData: optional(isAny),
        code: optional(isString),
        hostIdentity: optional(isString),
      }),
    ),
  }),
  [CMD.LIST_PEERS]: noArgs,
  [CMD.DROP_PEER]: object({ discoveryKeyHex: nonEmptyString }),
  [CMD.SET_REVOKED_DEVICES]: object({ keys: optional(arrayOf(isString)) }),
  [CMD.LOCKDOWN]: noArgs,
  // Lengths and filename rules are peer.exec's job; this is the shape.
  [CMD.EXEC]: object({
    peerId: nonEmptyString,
    code: nonEmptyString,
    cwd: optional(isString),
    mode: optional(isString),
    argv: optional(arrayOf(isString)),
    fileName: optional(isString),
    label: optional(isString),
    // Unioned with host-side detection: a declaration can only widen the prompt.
    declared: nested(
      object({
        network: optional(isString),
        device: optional(arrayOf(isString)),
      }),
    ),
  }),
  [CMD.CANCEL_EXEC]: object({ peerId: nonEmptyString }),
  [CMD.CLEAR_AUDIT]: noArgs,
  [CMD.CLEAR_PEER_AUDIT]: object({ discoveryKey: nonEmptyString }),
  [CMD.CLOSE]: noArgs,
};

/**
 * @param {number} command
 * @param {unknown} args
 * @returns {object}
 */
function validateCommand(command, args) {
  const schema = SCHEMAS[command];
  if (!schema) {
    throw new Error(`rpc: command ${command} has no schema`);
  }
  const problem = schema(args);
  if (problem) {
    throw new Error(`rpc: command ${command} payload rejected: ${problem}`);
  }
  return args ?? {};
}

module.exports = { validateCommand, SCHEMAS };
