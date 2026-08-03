// Who is actually on the other end of a pair.
//
// Each side announces its device key together with the keet-identity-key proof
// that binds that key to a root identity, and signs the other side's nonce to
// show it holds the matching secret. A proof alone proves nothing about the
// sender: proofs are public, so anyone who has seen one can replay it. Only the
// signature ties the announced key to whoever is on this connection.
'use strict';

const crypto = require('crypto');
const hypercoreCrypto = require('hypercore-crypto');
const IdentityKey = require('keet-identity-key');

const HELLO_KIND = 'identity-hello';
const PROOF_KIND = 'identity-proof';
// Domain separator plus the pair's discovery key, so a signature captured on
// one pair cannot be replayed on another.
const SIGN_CONTEXT = 'tether-academy/peer-identity/v1';
const NONCE_BYTES = 32;
const SIGNATURE_BYTES = 64;
// A handshake frame is a few hundred bytes. Anything larger is exec output that
// happens to contain the marker string.
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
  // The proof itself carries no identity field. The hello carries the
  // announced identityPublicKey, and the invite carries what was
  // promised; the comparison lives in the verification handler that has
  // both. expectedIdentity is plumbed for the case where a future
  // refactor moves the identity comparison into the verifier itself.
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
