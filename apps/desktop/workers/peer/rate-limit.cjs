// Sliding-window rate limit for the peer paths. One table covers per-peer and
// global limits: per-peer callers pass the discovery-key hex, global callers a
// fixed constant, so the bookkeeping is the same shape either way.
'use strict';

const LIMITS = Object.freeze({
  'exec:request':    { max: 10,  windowMs: 60_000 },  // per discovery key
  // Global ceiling across all invites, checked only after the per-invite
  // code gate. 60/min is a backstop, not a per-attacker budget.
  'pairing:attempt': { max: 60,  windowMs: 60_000 },  // global
  'identity:frame':  { max: 60,  windowMs: 60_000 },  // per discovery key
  'rpc:command':     { max: 600, windowMs: 60_000 },  // global, human-driven
});

// rpc:command is a backstop against a runaway loop on the worker RPC
// channel; calls originate from main and are driven by a human's UI.
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

// true => proceed, false => refused. `now` is injectable so tests can advance
// the window without sleeping.
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

// Drop per-key window entries the moment they empty; the global key stays
// since its window is the cross-invite budget.
function prune(op, key, now = Date.now()) {
  const byKey = windows.get(op);
  if (!byKey) return;
  const list = byKey.get(key);
  if (!list) return;
  const limit = LIMITS[op];
  if (!limit) return;
  const cutoff = now - limit.windowMs;
  let drop = 0;
  while (drop < list.length && list[drop] <= cutoff) drop += 1;
  if (drop > 0) list.splice(0, drop);
  if (list.length === 0 && key !== GLOBAL_KEY) byKey.delete(key);
}

// Drop the window for one key (per-peer teardown or test reset).
function reset(key) {
  for (const byKey of windows.values()) {
    byKey.delete(key);
  }
}

// Test-only; production resets per-key from dropPeer and close.
function _resetAllForTests() {
  windows.clear();
}

module.exports = {
  isAllowed,
  prune,
  reset,
  _resetAllForTests,
  LIMITS,
  GLOBAL_KEY,
};