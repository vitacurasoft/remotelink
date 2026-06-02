const { app, BrowserWindow, desktopCapturer, ipcMain, screen } = require('electron')
const path = require('path')
const inputController = require('./input-controller')

let win

function createWindow() {
  win = new BrowserWindow({
    width: 360,
    height: 280,
    resizable: false,
    title: 'RemoteLink Host',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.loadFile('host.html')
  win.setMenuBarVisibility(false)
}

// Fournit l'ID de la source écran au renderer
ipcMain.handle('get-screen-source', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 }
  })
  return sources[0]?.id || null
})

// Exécute les événements clavier/souris
ipcMain.on('input-event', (_, event) => {
  const display = screen.getPrimaryDisplay()
  const { width, height } = display.bounds
  inputController.handleInput(event, width, height)
})

// Minimise la fenêtre host quand le streaming démarre
ipcMain.on('minimize-window', () => {
  if (win) win.minimize()
})

app.whenReady().then(() => {
  inputController.start()
  createWindow()
})

app.on('window-all-closed', () => {
  inputController.stop()
  if (process.platform !== 'darwin') app.quit()
})
