const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__msgrPanel', {
  openMain: () => ipcRenderer.send('chat-panel-open-main'),
});
