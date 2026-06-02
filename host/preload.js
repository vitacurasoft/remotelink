const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('remotelink', {
  getScreenSourceId:  () => ipcRenderer.invoke('get-screen-source'),
  sendInput:          (event) => ipcRenderer.send('input-event', event),
  minimizeWindow:     () => ipcRenderer.send('minimize-window')
})
