// execFileSync isn't exported by bare-subprocess; this is a thin
// spawnSync-based replacement, portable to both Node and bare-subprocess.
'use strict';

// bare-subprocess's spawnSync doesn't honor `encoding`: it returns raw bytes
// even when requested, so decode explicitly rather than trust the runtime.
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
