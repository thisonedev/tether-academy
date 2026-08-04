// Per-invite wrong-code counter with short backoff and hard lockout.
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = 500;

function createPairingAttemptGate(opts = {}) {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  let failed = 0;
  let lastAt = 0;
  let invalidated = false;

  return {
    get attempts() {
      return failed;
    },
    get invalidated() {
      return invalidated;
    },
    get maxAttempts() {
      return maxAttempts;
    },
    // Returns 'backoff' | 'mismatch' | 'lockout'
    recordFailure(now = Date.now()) {
      if (invalidated) return 'lockout';
      if (lastAt > 0 && now - lastAt < backoffMs) return 'backoff';
      lastAt = now;
      failed += 1;
      if (failed >= maxAttempts) {
        invalidated = true;
        return 'lockout';
      }
      return 'mismatch';
    },
  };
}

module.exports = {
  createPairingAttemptGate,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_BACKOFF_MS,
};
