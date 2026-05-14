const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bubbleAPI', {
  getPosition: () => ipcRenderer.invoke('bubble-get-position'),
  setPosition: (x, y) => ipcRenderer.send('bubble-set-position', x, y),
  toggleChat: () => ipcRenderer.send('bubble-toggle-chat'),
  showContextMenu: () => ipcRenderer.send('bubble-context-menu'),
  hideBubble: () => ipcRenderer.send('bubble-hide'),
  onBadgeUpdate: (cb) => ipcRenderer.on('badge-update', (_, count) => cb(count)),
});
