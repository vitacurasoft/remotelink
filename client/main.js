const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

let win = null

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'RemoteLink',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.loadFile('index.html')
  win.setMenuBarVisibility(false)
}

// Fullscreen contrôlé depuis le renderer
ipcMain.on('set-fullscreen', (_, val) => {
  if (win) win.setFullScreen(val)
})

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
