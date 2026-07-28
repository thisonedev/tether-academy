const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('academy', {
  pkg: () => ipcRenderer.sendSync('pkg'),
  run: (payload) => ipcRenderer.invoke('academy:run', payload),
  stop: () => ipcRenderer.invoke('academy:stop'),
  onRunChunk: (callback) => {
    const handler = (_e, chunk) => callback(chunk);
    ipcRenderer.on('academy:run:chunk', handler);
    return () => ipcRenderer.removeListener('academy:run:chunk', handler);
  },
  qr: (text) => ipcRenderer.invoke('academy:qr', text),
  state: {
    get: (key) => ipcRenderer.invoke('academy:state:get', key),
    set: (key, value) => ipcRenderer.invoke('academy:state:set', key, value),
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
  },
  device: {
    info: () => ipcRenderer.invoke('academy:device:info'),
  },
  peer: {
    identity: () => ipcRenderer.invoke('academy:peer:identity'),
    invite: (opts) => ipcRenderer.invoke('academy:peer:invite', opts),
    accept: (inviteB64, opts) => ipcRenderer.invoke('academy:peer:accept', inviteB64, opts),
    list: () => ipcRenderer.invoke('academy:peer:list'),
    pending: () => ipcRenderer.invoke('academy:peer:pending'),
    approve: (requestId) => ipcRenderer.invoke('academy:peer:approve', requestId),
    reject: (requestId) => ipcRenderer.invoke('academy:peer:reject', requestId),
    audit: (opts) => ipcRenderer.invoke('academy:peer:audit', opts),
    clearAudit: () => ipcRenderer.invoke('academy:peer:clear-audit'),
    lockdown: () => ipcRenderer.invoke('academy:peer:lockdown'),
    drop: (discoveryKey) => ipcRenderer.invoke('academy:peer:drop', discoveryKey),
    onEvent: (callback) => {
      const handler = (_e, payload) => callback(payload);
      ipcRenderer.on('academy:peer:event', handler);
      return () => ipcRenderer.removeListener('academy:peer:event', handler);
    },
  },
});
