const { app, BrowserWindow, desktopCapturer, ipcMain, screen, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const inputController = require('./input-controller')

let win  = null
let tray = null
let isQuitting = false

// Détecte si lancé automatiquement au démarrage Windows
const IS_AUTOSTART = process.argv.includes('--autostart')

// ── Fenêtre principale ───────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 360,
    height: 300,
    resizable: false,
    title: 'RemoteLink Host',
    show: false,          // ne s'affiche jamais automatiquement
    skipTaskbar: true,    // masqué de la barre des tâches quand caché
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
    { label: 'Afficher la fenêtre', click: () => { win?.show(); win?.setSkipTaskbar(false); win?.focus() } },
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
    if (!win) return
    if (win.isVisible()) {
      win.hide()
      win.setSkipTaskbar(true)
    } else {
      win.show()
      win.setSkipTaskbar(false)
      win.focus()
    }
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

// Cache la fenêtre dans le tray
ipcMain.on('hide-window', () => win?.hide())

// Lecture/écriture du démarrage automatique
ipcMain.handle('get-autostart', () => app.getLoginItemSettings().openAtLogin)
ipcMain.on('set-autostart', (_, enabled) => {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    // Passe --autostart pour détecter le lancement auto et rester caché
    args: enabled ? ['--autostart'] : []
  })
  tray?.setContextMenu(buildTrayMenu())
})

// ── Démarrage ────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  inputController.start()
  createTray()
  createWindow()

  // Lance normalement → affiche la fenêtre
  // Lance au démarrage Windows (--autostart) → reste caché dans le tray
  if (!IS_AUTOSTART) {
    win.show()
    win.setSkipTaskbar(false)
  }
})

app.on('before-quit', () => { isQuitting = true })

app.on('window-all-closed', () => {
  // Ne pas quitter sur fermeture de fenêtre (tray reste actif)
})
