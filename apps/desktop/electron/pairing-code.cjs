const crypto = require('node:crypto');

const PAIRING_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIRING_CHARSET_LEN = PAIRING_CHARSET.length;
const PAIRING_CODE_LEN = 6;

function generate() {
  const bytes = crypto.randomBytes(PAIRING_CODE_LEN);
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LEN; i++) {
    code += PAIRING_CHARSET[bytes[i] % PAIRING_CHARSET_LEN];
  }
  return code;
}

function normalize(code) {
  return String(code).toUpperCase().replace(/[^A-Z2-9]/g, '');
}

function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const na = normalize(a);
  const nb = normalize(b);
  return na.length === PAIRING_CODE_LEN && na === nb;
}

module.exports = {
  generate,
  normalize,
  equal,
  PAIRING_CODE_LEN,
  PAIRING_CHARSET,
};
