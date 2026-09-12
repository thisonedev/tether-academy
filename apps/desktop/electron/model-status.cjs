'use strict';

// One shared channel every capability's model loader reports through, so the
// playground can show "Downloading/Loading the X model (name)" the same way
// regardless of which capability triggered it.

const { EventEmitter } = require('node:events');

const events = new EventEmitter();
events.setMaxListeners(50);

// Last non-'ready' status, so a page that (re)mounts mid-load (the header
// badge on every navigation) can catch up instead of waiting for the next tick.
let current = null;

/** @param {{ name: string, kind: string, phase: 'downloading'|'loading'|'ready', downloaded?: number, total?: number }} status */
function notify(status) {
  current = status.phase === 'ready' ? null : status;
  events.emit('status', status);
}

function onStatus(callback) {
  events.on('status', callback);
  return () => events.off('status', callback);
}

function currentStatus() {
  return current;
}

module.exports = { notify, onStatus, currentStatus };
