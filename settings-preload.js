const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  get: () => ipcRenderer.invoke('settings-get'),
  set: (next) => ipcRenderer.send('settings-set', next),
  getCacheSize: () => ipcRenderer.invoke('settings-get-cache-size'),
  clearCache: () => ipcRenderer.invoke('settings-clear-cache'),
  onUpdate: (cb) => ipcRenderer.on('settings-update', (_, s) => cb(s)),
});
