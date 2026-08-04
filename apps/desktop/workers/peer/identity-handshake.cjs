// Each side announces its device key with a keet-identity-key proof binding it
// to a root identity, then signs the other side's nonce. Proofs are public and
// replayable; only the signature proves who is actually on this connection.
'use strict';

const crypto = require('crypto');
const hypercoreCrypto = require('hypercore-crypto');
const IdentityKey = require('keet-identity-key');

const HELLO_KIND = 'identity-hello';
const PROOF_KIND = 'identity-proof';
// Domain separator plus discovery key, so a signature can't be replayed on another pair.
const SIGN_CONTEXT = 'tether-academy/peer-identity/v1';
const NONCE_BYTES = 32;
const SIGNATURE_BYTES = 64;
// A handshake frame is a few hundred bytes; anything larger is exec output
// that happens to contain the marker string.
const MAX_FRAME_BYTES = 8192;
const HEX_32 = /^[0-9a-fA-F]{64}$/;

function newNonce() {
  return crypto.randomBytes(NONCE_BYTES).toString('hex');
}

function signable(discoveryKeyHex, nonceHex) {
  return Buffer.from(`${SIGN_CONTEXT}\n${discoveryKeyHex}\n${nonceHex}`, 'utf8');
}

/** hypercore-crypto keypair from the 32-byte device seed peer.init receives. */
function deriveSigningKeyPair(privateKeyHex) {
  return hypercoreCrypto.keyPair(Buffer.from(privateKeyHex, 'hex'));
}

/** Cheap pre-check so exec stdout chunks skip JSON.parse. */
function isIdentityFrame(buf) {
  if (!buf || buf.length > MAX_FRAME_BYTES) return false;
  const head = Buffer.from(buf).subarray(0, Math.min(buf.length, 48)).toString('utf8');
  return head.includes(`"${HELLO_KIND}"`) || head.includes(`"${PROOF_KIND}"`);
}

function buildHello(nonce, claim) {
  return {
    kind: HELLO_KIND,
    nonce,
    devicePublicKey: claim.devicePublicKey,
    identityPublicKey: claim.identityPublicKey ?? null,
    proof: claim.proof ?? null,
  };
}

function verifyAttestation(proofB64, devicePublicKeyHex, identityPublicKeyHex) {
  try {
    const info = IdentityKey.verify(Buffer.from(proofB64, 'base64'), null, {
      expectedDevice: Buffer.from(devicePublicKeyHex, 'hex'),
      expectedIdentity: Buffer.from(identityPublicKeyHex, 'hex'),
    });
    return !!info;
  } catch {
    return false;
  }
}

/**
 * The remote's announced keys. `identityProven` says the attestation chain holds
 * up; it does not yet say the sender owns the device key. That takes the reply.
 */
function readHello(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const { nonce, devicePublicKey } = msg;
  if (typeof nonce !== 'string' || !HEX_32.test(nonce)) return null;
  if (typeof devicePublicKey !== 'string' || !HEX_32.test(devicePublicKey)) return null;

  const identityPublicKey =
    typeof msg.identityPublicKey === 'string' && HEX_32.test(msg.identityPublicKey)
      ? msg.identityPublicKey
      : null;
  const proof =
    typeof msg.proof === 'string' && msg.proof.length > 0 && msg.proof.length <= MAX_FRAME_BYTES
      ? msg.proof
      : null;

  return {
    nonce,
    devicePublicKey,
    identityPublicKey,
    identityProven:
      !!identityPublicKey && !!proof && verifyAttestation(proof, devicePublicKey, identityPublicKey),
  };
}

function buildProofReply(discoveryKeyHex, nonce, signingKeyPair) {
  const signature = hypercoreCrypto.sign(
    signable(discoveryKeyHex, nonce),
    signingKeyPair.secretKey,
  );
  return { kind: PROOF_KIND, nonce, signature: Buffer.from(signature).toString('base64') };
}

/** Checks the reply answers our own nonce and was signed by the announced key. */
function verifyProofReply(msg, { discoveryKeyHex, nonce, devicePublicKey, expectedIdentity = null }) {
  if (!msg || typeof msg.signature !== 'string') return false;
  if (msg.nonce !== nonce) return false;
  const signature = Buffer.from(msg.signature, 'base64');
  if (signature.length !== SIGNATURE_BYTES) return false;
  // The proof carries no identity field; that comparison lives in the
  // verification handler. expectedIdentity is unused today, reserved for a
  // future refactor that moves it here.
  if (expectedIdentity != null && msg.devicePublicKey !== expectedIdentity) return false;
  try {
    return hypercoreCrypto.verify(
      signable(discoveryKeyHex, nonce),
      signature,
      Buffer.from(devicePublicKey, 'hex'),
    );
  } catch {
    return false;
  }
}

module.exports = {
  HELLO_KIND,
  PROOF_KIND,
  SIGN_CONTEXT,
  buildHello,
  buildProofReply,
  deriveSigningKeyPair,
  isIdentityFrame,
  newNonce,
  readHello,
  signable,
  verifyAttestation,
  verifyProofReply,
};
