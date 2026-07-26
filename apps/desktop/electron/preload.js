const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('academy', {
  pkg: () => ipcRenderer.sendSync('pkg'),
  run: (payload) => ipcRenderer.invoke('academy:run', payload),
  onRunChunk: (callback) => {
    const handler = (_e, chunk) => callback(chunk);
    ipcRenderer.on('academy:run:chunk', handler);
    return () => ipcRenderer.removeListener('academy:run:chunk', handler);
  },
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
});
