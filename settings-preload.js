const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsAPI', {
  get: () => ipcRenderer.invoke('settings-get'),
  set: (next) => ipcRenderer.send('settings-set', next),
  onUpdate: (cb) => ipcRenderer.on('settings-update', (_, s) => cb(s)),
});
