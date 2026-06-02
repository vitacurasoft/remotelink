const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('remotelink', {
  onStatus:      (cb) => ipcRenderer.on('status', (_, msg) => cb(msg)),
  setFullScreen: (val) => ipcRenderer.send('set-fullscreen', val)
})
