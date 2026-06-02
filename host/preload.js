const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('remotelink', {
  getScreenSourceId:  () => ipcRenderer.invoke('get-screen-source'),
  sendInput:          (event) => ipcRenderer.send('input-event', event),
  minimizeWindow:     () => ipcRenderer.send('minimize-window'),
  setTrayStatus:      (status) => ipcRenderer.send('tray-status', status),
  hideWindow:         () => ipcRenderer.send('hide-window'),
  getAutostart:       () => ipcRenderer.invoke('get-autostart'),
  setAutostart:       (enabled) => ipcRenderer.send('set-autostart', enabled)
})
