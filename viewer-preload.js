const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__msgrViewer', {
  onData: (cb) => ipcRenderer.on('viewer-data', (_e, data) => cb(data)),
  saveCopy: () => ipcRenderer.send('viewer-save-copy'),
  openExternal: () => ipcRenderer.send('viewer-open-external'),
});
