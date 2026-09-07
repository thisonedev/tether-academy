'use strict';

// One shared channel every capability's model loader reports through, so the
// playground can show "Downloading/Loading the X model (name)" the same way
// regardless of which capability triggered it.

const { EventEmitter } = require('node:events');

const events = new EventEmitter();
events.setMaxListeners(50);

/** @param {{ name: string, kind: string, phase: 'downloading'|'loading', downloaded?: number, total?: number }} status */
function notify(status) {
  events.emit('status', status);
}

function onStatus(callback) {
  events.on('status', callback);
  return () => events.off('status', callback);
}

module.exports = { notify, onStatus };
