const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('remotelink', {
  onStatus: (callback) => ipcRenderer.on('status', (_, msg) => callback(msg))
})
