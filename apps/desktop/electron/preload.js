const { contextBridge, ipcRenderer } = require('electron');

// Tag the document so the web app can apply macOS-specific layout
// (e.g. left padding to clear the hiddenInset traffic lights).
function tagPlatform() {
  if (document.documentElement) {
    document.documentElement.dataset.platform = process.platform;
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', tagPlatform, { once: true });
} else {
  tagPlatform();
}

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
