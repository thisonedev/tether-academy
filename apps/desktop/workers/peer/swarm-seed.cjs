// Derive a Hyperswarm seed from private key material via HKDF.
// Never seed from a public identity key — that would let anyone who has
// seen the pubkey recompute the Noise keypair. Domain-separated info
// strings keep mesh and QVAC seeds distinct.
const crypto = require('crypto');

const PEER_SWARM_INFO = 'tether-academy/peer-swarm-v1';
const QVAC_SWARM_INFO = 'tether-academy/qvac-swarm-v1';

// bare-crypto has no hkdfSync. RFC 5869 HKDF-SHA256 built from createHmac,
// which both real Node crypto and bare-crypto export. Used only as a
// fallback so the real Node crypto.hkdfSync path (main process) is untouched.
function hkdfSha256Compat(ikm, salt, info, keylen) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const hashLen = prk.length;
  const n = Math.ceil(keylen / hashLen);
  const okm = Buffer.alloc(n * hashLen);
  let t = Buffer.alloc(0);
  for (let i = 1; i <= n; i++) {
    t = crypto.createHmac('sha256', prk).update(t).update(info).update(Buffer.from([i])).digest();
    t.copy(okm, (i - 1) * hashLen);
  }
  return okm.subarray(0, keylen);
}

function hkdfSync(algo, ikm, salt, info, keylen) {
  if (typeof crypto.hkdfSync === 'function') {
    return crypto.hkdfSync(algo, ikm, salt, info, keylen);
  }
  if (algo !== 'sha256') throw new Error('hkdfSync fallback only supports sha256');
  return hkdfSha256Compat(ikm, salt, info, keylen);
}

function deriveSwarmSeed(privateKeyHex, info = PEER_SWARM_INFO) {
  if (typeof privateKeyHex !== 'string' || !/^[0-9a-fA-F]+$/.test(privateKeyHex)) {
    throw new Error('deriveSwarmSeed: privateKeyHex must be non-empty hex');
  }
  const ikm = Buffer.from(privateKeyHex, 'hex');
  if (ikm.length < 32) {
    throw new Error('deriveSwarmSeed: private key material must be at least 32 bytes');
  }
  // Ed25519 JWK "d" is 32 bytes; take the first 32 if longer.
  const keyMaterial = ikm.subarray(0, 32);
  const infoBuf = Buffer.from(info, 'utf8');
  // Node's @types/crypto types hkdfSync's return as `ArrayBufferLike`, but the
  // runtime returns a Buffer; Buffer.from accepts the wider type.
  /** @type {Buffer} */
  const okm = Buffer.from(/** @type {ArrayBufferLike} */ (hkdfSync('sha256', keyMaterial, Buffer.alloc(0), infoBuf, 32)));
  return okm;
}

function deriveSwarmSeedHex(privateKeyHex, info = PEER_SWARM_INFO) {
  return deriveSwarmSeed(privateKeyHex, info).toString('hex');
}

module.exports = {
  deriveSwarmSeed,
  deriveSwarmSeedHex,
  PEER_SWARM_INFO,
  QVAC_SWARM_INFO,
};
