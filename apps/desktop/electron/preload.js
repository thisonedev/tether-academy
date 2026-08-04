const { contextBridge, ipcRenderer } = require('electron');

// Declared, not cast: a `@type` assertion would silence mismatches instead
// of failing `pnpm typecheck`.
/** @type {import('@academy/validation').AcademyAPI} */
const academy = {
  pkg: () => ipcRenderer.sendSync('pkg'),
  run: (payload) => ipcRenderer.invoke('academy:run', payload),
  stop: () => ipcRenderer.invoke('academy:stop'),
  reveal: (filePath) => ipcRenderer.invoke('academy:reveal', filePath),
  readSaved: (filePath) => ipcRenderer.invoke('academy:read-saved', filePath),
  onRunChunk: (callback) => {
    const handler = (/** @type {unknown} */ _e, /** @type {any} */ chunk) => callback(chunk);
    ipcRenderer.on('academy:run:chunk', handler);
    return () => ipcRenderer.removeListener('academy:run:chunk', handler);
  },
  state: {
    get: (key) => ipcRenderer.invoke('academy:state:get', key),
    set: (key, value) => ipcRenderer.invoke('academy:state:set', { key, value }),
    remove: (key) => ipcRenderer.invoke('academy:state:remove', key),
    list: () => ipcRenderer.invoke('academy:state:list'),
  },
  window: {
    minimize: () => ipcRenderer.invoke('academy:window:minimize'),
    maximize: () => ipcRenderer.invoke('academy:window:maximize'),
    close: () => ipcRenderer.invoke('academy:window:close'),
  },
  models: {
    list: () => ipcRenderer.invoke('academy:models:list'),
    remove: (id) => ipcRenderer.invoke('academy:models:remove', id),
    removeAll: () => ipcRenderer.invoke('academy:models:removeAll'),
    verify: () => ipcRenderer.invoke('academy:models:verify'),
  },
  device: {
    info: () => ipcRenderer.invoke('academy:device:info'),
  },
  clipboard: {
    copy: (text, scrubAfterMs) =>
      ipcRenderer.invoke('academy:clipboard:copy', { text, scrubAfterMs }),
  },
  identity: {
    status: () => ipcRenderer.invoke('academy:identity:status'),
    create: () => ipcRenderer.invoke('academy:identity:create'),
    confirmBackup: () => ipcRenderer.invoke('academy:identity:confirm-backup'),
    recover: (mnemonic) => ipcRenderer.invoke('academy:identity:recover', mnemonic),
    beginAttest: (payload) => ipcRenderer.invoke('academy:identity:begin-attest', payload),
    finishAttest: (payload) => ipcRenderer.invoke('academy:identity:finish-attest', payload),
    cancelAttest: (sessionId) => ipcRenderer.invoke('academy:identity:cancel-attest', sessionId),
    revokeDevice: (devicePublicKey) =>
      ipcRenderer.invoke('academy:identity:revoke-device', devicePublicKey),
    listDevices: () => ipcRenderer.invoke('academy:identity:list-devices'),
    reset: () => ipcRenderer.invoke('academy:identity:reset'),
    // Attested blob store: username, progress, future xp/reputation.
    setUsername: (payload) => ipcRenderer.invoke('academy:identity:set-username', payload),
    getUsername: () => ipcRenderer.invoke('academy:identity:get-username'),
    setProgress: (payload) => ipcRenderer.invoke('academy:identity:set-progress', payload),
    getProgress: () => ipcRenderer.invoke('academy:identity:get-progress'),
    listBlobs: () => ipcRenderer.invoke('academy:identity:list-blobs'),
    publicSnapshot: () => ipcRenderer.invoke('academy:identity:public-snapshot'),
    verifyAttested: (payload) => ipcRenderer.invoke('academy:identity:verify-attested', payload),
    importProfile: (payload) => ipcRenderer.invoke('academy:identity:import-profile', payload),
  },
  peer: {
    identity: () => ipcRenderer.invoke('academy:peer:identity'),
    takeDeeplink: () => ipcRenderer.invoke('academy:peer:take-deeplink'),
    // Only userData is accepted by main; do not forward autoApprove/code.
    invite: (opts) => {
      const userData =
        opts && typeof opts === 'object' && opts.userData != null ? opts.userData : null;
      return ipcRenderer.invoke('academy:peer:invite', userData != null ? { userData } : {});
    },
    accept: (inviteB64, opts) => {
      const safe = {};
      if (opts && typeof opts === 'object') {
        if (opts.userData != null) safe.userData = opts.userData;
        if (opts.code != null) safe.code = opts.code;
        if (opts.hostIdentity != null) safe.hostIdentity = opts.hostIdentity;
      }
      return ipcRenderer.invoke('academy:peer:accept', { inviteB64, opts: safe });
    },
    list: () => ipcRenderer.invoke('academy:peer:list'),
    pending: () => ipcRenderer.invoke('academy:peer:pending'),
    deviceRequests: () => ipcRenderer.invoke('academy:peer:device-requests'),
    resolveDeviceRequest: (requestId, approved) =>
      ipcRenderer.invoke('academy:peer:device-consent', { requestId, approved: approved === true }),
    approve: (requestId) => ipcRenderer.invoke('academy:peer:approve', requestId),
    reject: (requestId) => ipcRenderer.invoke('academy:peer:reject', requestId),
    audit: (opts) => ipcRenderer.invoke('academy:peer:audit', opts),
    clearAudit: () => ipcRenderer.invoke('academy:peer:clear-audit'),
    clearPeerAudit: (discoveryKey) => ipcRenderer.invoke('academy:peer:clear-peer-audit', discoveryKey),
    lockdown: () => ipcRenderer.invoke('academy:peer:lockdown'),
    drop: (discoveryKey) => ipcRenderer.invoke('academy:peer:drop', discoveryKey),
    onEvent: (callback) => {
      const handler = (/** @type {unknown} */ _e, /** @type {any} */ payload) => callback(payload);
      ipcRenderer.on('academy:peer:event', handler);
      return () => ipcRenderer.removeListener('academy:peer:event', handler);
    },
  },
};

contextBridge.exposeInMainWorld('academy', academy);
