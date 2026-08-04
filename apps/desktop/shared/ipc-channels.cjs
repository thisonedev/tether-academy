// One row per ipcMain.handle() channel main.js registers, mapped to the
// @academy/validation schema its payload parses against (or null when none).
// A channel not listed here throws at startup.
'use strict';

const PEAR_WORKER_PREFIX = 'pear:worker:writeIPC:';

const IPC_CHANNELS = Object.freeze({
  // The registry also documents the sendSync exception.
  pkg: null,
  'academy:run': 'academyRunPayloadSchema',
  'academy:stop': null,
  'academy:reveal': 'academyRevealPathSchema',
  'academy:state:get': 'stateKeySchema',
  'academy:state:set': 'stateSetSchema',
  'academy:state:remove': 'stateKeySchema',
  'academy:state:list': null,
  'academy:window:minimize': null,
  'academy:window:maximize': null,
  'academy:window:close': null,
  'academy:clipboard:copy': 'clipboardCopySchema',
  'academy:models:list': null,
  'academy:models:remove': 'modelIdSchema',
  'academy:models:removeAll': null,
  'academy:models:verify': null,
  'academy:device:info': null,
  'academy:peer:identity': null,
  'academy:identity:status': null,
  'academy:identity:create': null,
  'academy:identity:confirm-backup': null,
  'academy:identity:recover': 'identityMnemonicSchema',
  'academy:identity:begin-attest': 'identityBeginAttestPayloadSchema',
  'academy:identity:finish-attest': 'identityFinishAttestPayloadSchema',
  'academy:identity:cancel-attest': 'identitySessionIdSchema',
  'academy:identity:revoke-device': 'devicePublicKeyHexSchema',
  'academy:identity:list-devices': null,
  'academy:identity:reset': null,
  'academy:peer:take-deeplink': null,
  'academy:peer:invite': 'peerInviteOptsSchema',
  'academy:peer:approve': 'peerRequestIdSchema',
  'academy:peer:reject': 'peerRequestIdSchema',
  'academy:peer:pending': null,
  'academy:peer:device-consent': 'peerDeviceConsentSchema',
  'academy:peer:device-requests': null,
  'academy:peer:audit': 'peerAuditOptsSchema',
  'academy:peer:clear-audit': null,
  'academy:peer:clear-peer-audit': 'peerDiscoveryKeySchema',
  'academy:peer:lockdown': null,
  'academy:peer:accept': 'peerAcceptSchema',
  'academy:peer:list': null,
  'academy:peer:drop': 'peerDiscoveryKeySchema',
  'pear:startWorker': 'workerSpecifierSchema',
  // pear:worker:writeIPC:* is dynamic; the wrapper resolves the prefix here.
  [PEAR_WORKER_PREFIX]: 'workerIpcDataSchema',
});

const exportedChannels = { ...IPC_CHANNELS, PEAR_WORKER_PREFIX };
module.exports = Object.freeze(exportedChannels);
