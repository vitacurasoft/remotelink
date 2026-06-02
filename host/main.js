const { app, BrowserWindow, desktopCapturer, ipcMain, screen, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const inputController = require('./input-controller')

let win  = null
let tray = null
let isQuitting = false

// ── Fenêtre principale ───────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 360,
    height: 280,
    resizable: false,
    title: 'RemoteLink Host',
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.loadFile('host.html')
  win.setMenuBarVisibility(false)

  // Masque dans le tray au lieu de fermer
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })
}

// ── Icône tray système ───────────────────────────────────────────────────────

function buildTrayMenu(status = 'En attente...') {
  const loginSettings = app.getLoginItemSettings()
  return Menu.buildFromTemplate([
    { label: 'RemoteLink Host', enabled: false },
    { label: status, enabled: false },
    { type: 'separator' },
    {
      label: 'Démarrer avec Windows',
      type: 'checkbox',
      checked: loginSettings.openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          openAsHidden: item.checked
        })
        tray.setContextMenu(buildTrayMenu(status))
      }
    },
    { type: 'separator' },
    { label: 'Afficher la fenêtre', click: () => win?.show() },
    { label: 'Quitter RemoteLink', click: () => { isQuitting = true; app.quit() } }
  ])
}

function createTray() {
  // Tente de charger un icône, sinon utilise une image vide
  let icon
  const iconPath = path.join(__dirname, 'assets', 'tray.png')
  try { icon = nativeImage.createFromPath(iconPath) } catch {}
  if (!icon || icon.isEmpty()) icon = nativeImage.createEmpty()

  tray = new Tray(icon)
  tray.setToolTip('RemoteLink Host')
  tray.setContextMenu(buildTrayMenu())

  // Clic gauche → affiche/masque la fenêtre
  tray.on('click', () => {
    if (win) win.isVisible() ? win.hide() : win.show()
  })
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('get-screen-source', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 }
  })
  return sources[0]?.id || null
})

ipcMain.on('input-event', (_, event) => {
  const display = screen.getPrimaryDisplay()
  const { width, height } = display.bounds
  inputController.handleInput(event, width, height)
})

ipcMain.on('minimize-window', () => {
  win?.hide()
})

// Met à jour le tooltip/menu du tray depuis le renderer
ipcMain.on('tray-status', (_, status) => {
  if (!tray) return
  tray.setToolTip(`RemoteLink Host — ${status}`)
  tray.setContextMenu(buildTrayMenu(status))
})

// ── Démarrage ────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  inputController.start()
  createTray()
  createWindow()

  // Si lancé au démarrage Windows → reste caché, pas besoin d'afficher la fenêtre
  const { wasOpenedAsHidden } = app.getLoginItemSettings()
  if (!wasOpenedAsHidden) win.show()
})

app.on('before-quit', () => { isQuitting = true })

app.on('window-all-closed', () => {
  // Ne pas quitter sur fermeture de fenêtre (tray reste actif)
})
