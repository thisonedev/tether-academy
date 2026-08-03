// Sliding-window rate limit for the peer paths. One table covers per-peer
// and global limits: callers pass the discovery-key hex for per-peer ops and
// a fixed constant for global ones, so the bookkeeping is the same shape
// either way. Timestamps are pruned on read, so a peer that went away leaves
// no trace in the table.
'use strict';

const LIMITS = Object.freeze({
  'exec:request':    { max: 10,  windowMs: 60_000 },  // per discovery key
  'pairing:attempt': { max: 20,  windowMs: 60_000 },  // global
  'identity:frame':  { max: 60,  windowMs: 60_000 },  // per discovery key
  'rpc:command':     { max: 600, windowMs: 60_000 },  // global, human-driven
});

// `rpc:command` exists to stop a runaway loop on the worker RPC channel; the
// number is a backstop rather than a per-attacker budget, since these calls
// originate from main and are driven by a human's UI.
const GLOBAL_KEY = '__global__';

// op -> key -> ascending list of timestamps inside the window.
const windows = new Map();

function getWindow(op, key) {
  let byKey = windows.get(op);
  if (!byKey) {
    byKey = new Map();
    windows.set(op, byKey);
  }
  let list = byKey.get(key);
  if (!list) {
    list = [];
    byKey.set(key, list);
  }
  return list;
}

// true => proceed, false => refused. `now` is injectable so unit tests do not
// have to sleep a minute to advance the window.
function isAllowed(op, key, now = Date.now()) {
  const limit = LIMITS[op];
  if (!limit) return false;
  if (typeof key !== 'string' || key.length === 0) return false;
  const list = getWindow(op, key);
  const cutoff = now - limit.windowMs;
  let drop = 0;
  while (drop < list.length && list[drop] <= cutoff) drop += 1;
  if (drop > 0) list.splice(0, drop);
  if (list.length >= limit.max) return false;
  list.push(now);
  return true;
}

// Drop the window for one key (per-peer teardown or test reset).
function reset(key) {
  for (const byKey of windows.values()) {
    byKey.delete(key);
  }
}

// Test-only: clear every window. The production path resets per-key from
// dropPeer and close.
function _resetAllForTests() {
  windows.clear();
}

module.exports = {
  isAllowed,
  reset,
  _resetAllForTests,
  LIMITS,
  GLOBAL_KEY,
};