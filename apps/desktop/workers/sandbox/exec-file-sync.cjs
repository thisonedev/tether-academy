// execFileSync isn't exported by bare-subprocess; this is a thin
// spawnSync-based replacement with the same call shape, portable to
// both Node's real child_process and bare-subprocess.
'use strict';

// bare-subprocess's spawnSync doesn't honor the `encoding` option the way
// Node's real spawnSync does: it returns raw bytes (Buffer or a plain
// byte array) for stdout/stderr even when encoding is requested. Decode
// explicitly instead of trusting the runtime to have done it.
function decode(value, encoding) {
  if (value == null || typeof value === 'string' || !encoding) return value;
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buf.toString(encoding);
}

function execFileSyncCompat(file, args, opts = {}) {
  const { spawnSync } = require('child_process');
  const result = spawnSync(file, args, opts);
  if (result.error) throw result.error;
  const stdout = decode(result.stdout, opts.encoding);
  const stderr = decode(result.stderr, opts.encoding);
  if (result.status !== 0) {
    const err = /** @type {Error & { status?: number, stdout?: string, stderr?: string }} */ (
      new Error(`Command failed: ${file} ${(args || []).join(' ')}`)
    );
    err.status = result.status;
    err.stdout = stdout;
    err.stderr = stderr;
    throw err;
  }
  return stdout;
}

module.exports = { execFileSyncCompat };
