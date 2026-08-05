'use strict';

// Cross-process mutex for `tether-academy update`, mirroring Hermes'
// update_lock.py: a pid+timestamp marker file, stale/dead holders self-heal
// instead of wedging every future update.
const fs = require('node:fs');
const { lockPath } = require('./home');

const MAX_AGE_MS = 20 * 60 * 1000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, but owned by someone else
  }
}

function readLiveHolder() {
  let raw;
  try {
    raw = fs.readFileSync(lockPath(), 'utf8');
  } catch {
    return null; // absent or unreadable => no live update
  }
  const [pidLine, startedLine] = raw.split('\n');
  const pid = Number.parseInt(pidLine, 10);
  const startedAt = Number.parseInt(startedLine, 10);
  const age = Date.now() - (Number.isFinite(startedAt) ? startedAt : 0);
  if (!pidAlive(pid) || age > MAX_AGE_MS) {
    try {
      fs.unlinkSync(lockPath());
    } catch {
      // best-effort
    }
    return null;
  }
  return { pid, age };
}

class UpdateLock {
  acquire() {
    const existing = readLiveHolder();
    if (existing) return { acquired: false, holder: existing };
    fs.mkdirSync(require('node:path').dirname(lockPath()), { recursive: true });
    fs.writeFileSync(lockPath(), `${process.pid}\n${Date.now()}\n`, { encoding: 'utf8', mode: 0o600 });
    this._acquired = true;
    return { acquired: true };
  }

  release() {
    if (!this._acquired) return;
    this._acquired = false;
    try {
      const raw = fs.readFileSync(lockPath(), 'utf8');
      const owner = Number.parseInt(raw.split('\n')[0], 10);
      if (owner === process.pid) fs.unlinkSync(lockPath());
    } catch {
      // already gone
    }
  }
}

function describeHolder(holder) {
  const seconds = Math.max(0, Math.round(holder.age / 1000));
  return (
    `Another tether-academy update is already running (pid ${holder.pid}, started ${seconds}s ago).\n` +
    `Wait for it to finish, or close the process that started it, then retry.`
  );
}

module.exports = { UpdateLock, readLiveHolder, describeHolder };
