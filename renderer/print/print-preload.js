const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onPrintContent: (cb) => ipcRenderer.on('print:content', (e, payload) => cb(payload))
});
