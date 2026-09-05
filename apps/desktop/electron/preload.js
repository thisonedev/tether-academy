const { contextBridge, ipcRenderer } = require('electron');

// `@type` would silence mismatches instead of failing `pnpm typecheck`.
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
    catalogue: () => ipcRenderer.invoke('academy:models:catalogue'),
    recommend: (lessonKey) => ipcRenderer.invoke('academy:models:recommend', lessonKey),
    forLesson: (lessonKey) => ipcRenderer.invoke('academy:models:for-lesson', lessonKey),
  },
  device: {
    info: () => ipcRenderer.invoke('academy:device:info'),
  },
  chat: {
    ready: () => ipcRenderer.invoke('academy:chat:ready'),
    currentModel: () => ipcRenderer.invoke('academy:chat:current-model'),
    configuredModel: () => ipcRenderer.invoke('academy:chat:configured-model'),
    docsStatus: () => ipcRenderer.invoke('academy:chat:docs-status'),
    docsRefresh: () => ipcRenderer.invoke('academy:chat:docs-refresh'),
    load: (modelHint) => ipcRenderer.invoke('academy:chat:load', modelHint),
    send: (payload) => ipcRenderer.invoke('academy:chat:send', payload),
    verify: (payload) => ipcRenderer.invoke('academy:chat:verify', payload),
    securityScan: (payload) => ipcRenderer.invoke('academy:chat:security-scan', payload),
    stop: (requestId) => ipcRenderer.invoke('academy:chat:stop', requestId),
    onChunk: (callback) => {
      const handler = (/** @type {unknown} */ _e, /** @type {any} */ chunk) => callback(chunk);
      ipcRenderer.on('academy:chat:chunk', handler);
      return () => ipcRenderer.removeListener('academy:chat:chunk', handler);
    },
    onVerifyResult: (callback) => {
      const handler = (/** @type {unknown} */ _e, /** @type {any} */ result) => callback(result);
      ipcRenderer.on('academy:chat:verify-result', handler);
      return () => ipcRenderer.removeListener('academy:chat:verify-result', handler);
    },
    onSecurityResult: (callback) => {
      const handler = (/** @type {unknown} */ _e, /** @type {any} */ result) => callback(result);
      ipcRenderer.on('academy:chat:security-result', handler);
      return () => ipcRenderer.removeListener('academy:chat:security-result', handler);
    },
    onLoadProgress: (callback) => {
      const handler = (/** @type {unknown} */ _e, /** @type {any} */ progress) => callback(progress);
      ipcRenderer.on('academy:chat:load-progress', handler);
      return () => ipcRenderer.removeListener('academy:chat:load-progress', handler);
    },
  },
  clipboard: {
    copy: (text, scrubAfterMs) =>
      ipcRenderer.invoke('academy:clipboard:copy', { text, scrubAfterMs }),
  },
  playgroundCredentials: {
    list: () => ipcRenderer.invoke('academy:playground-credentials:list'),
    set: (name, value) => ipcRenderer.invoke('academy:playground-credentials:set', { name, value }),
    delete: (name) => ipcRenderer.invoke('academy:playground-credentials:delete', name),
  },
  translate: (text, language) => ipcRenderer.invoke('academy:translate', { text, language }),
  workflow: {
    generate: (prompt, catalogue, currentWorkflow) =>
      ipcRenderer.invoke('academy:workflow:generate', { prompt, catalogue, currentWorkflow }),
  },
  ragSearch: (documents, query, topK) => ipcRenderer.invoke('academy:rag-search', { documents, query, topK }),
  ocr: (image) => ipcRenderer.invoke('academy:ocr', { image }),
  classifyImage: (image) => ipcRenderer.invoke('academy:classify-image', { image }),
  textToSpeech: (text) => ipcRenderer.invoke('academy:text-to-speech', { text }),
  speechToText: (audio) => ipcRenderer.invoke('academy:speech-to-text', { audio }),
  generateImage: (prompt, model) => ipcRenderer.invoke('academy:generate-image', { prompt, model }),
  generateVideo: (prompt, model, frames, steps) => ipcRenderer.invoke('academy:generate-video', { prompt, model, frames, steps }),
  cancelGenerateVideo: () => ipcRenderer.invoke('academy:generate-video:cancel'),
  generateMusic: (caption, durationSec) => ipcRenderer.invoke('academy:generate-music', { caption, durationSec }),
  cancelGenerateMusic: () => ipcRenderer.invoke('academy:generate-music:cancel'),
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
