const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('remotelink', {
  getScreenSourceId: () => ipcRenderer.invoke('get-screen-source')
})
