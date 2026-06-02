const SIGNALING_URL = 'https://remotelink-h336.onrender.com'
const STUN_SERVERS  = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] }

// ── DOM ─────────────────────────────────────────────────────────────────────
const connectViewEl   = document.getElementById('connect-view')
const streamViewEl    = document.getElementById('stream-view')
const statusEl        = document.getElementById('status')
const videoEl         = document.getElementById('screen')
const btnEl           = document.getElementById('btn-connect')
const hudEl           = document.getElementById('hud')
const overlayReleased = document.getElementById('overlay-released')
const toastEsc        = document.getElementById('toast-esc')
const reconnectBadge  = document.getElementById('reconnect-badge')
const btnExplorer     = document.getElementById('btn-explorer')
const filePanel       = document.getElementById('file-panel')
const fpTitle         = document.getElementById('fp-title')
const fpBreadcrumb    = document.getElementById('fp-breadcrumb')
const fpList          = document.getElementById('fp-list')
const fpStatus        = document.getElementById('fp-status')
const btnFpClose      = document.getElementById('btn-fp-close')

// ── State ────────────────────────────────────────────────────────────────────
let socket = null, peerConnection = null, inputChannel = null
let statsInterval = null, reconnectTimer = null, isConnected = false
let controlEnabled = true, lastEscTime = 0, toastTimer = null
const DOUBLE_ESC_MS = 600
let lastMoveTime = 0
const MOVE_THROTTLE_MS = 40

// ── Explorateur de fichiers ──────────────────────────────────────────────────
let fsRequests  = {}   // id → { resolve }
let fileBuffers = {}   // id → { name, total, chunks[] }
let currentPath = ''
let reqCounter  = 0

function genId() { return 'r' + (++reqCounter) }

// Formate la taille
function fmtSize(bytes) {
  if (bytes === 0) return ''
  if (bytes < 1024) return bytes + ' o'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' Ko'
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' Mo'
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' Go'
}

// Envoie une requête FS au host via DataChannel
function fsSend(msg) {
  if (inputChannel && inputChannel.readyState === 'open') {
    inputChannel.send(JSON.stringify(msg))
  }
}

// Requête liste répertoire
function fsListDir(path) {
  return new Promise(resolve => {
    const id = genId()
    fsRequests[id] = resolve
    fsSend({ type: 'fs-list', id, path: path || '' })
    setTimeout(() => { if (fsRequests[id]) { delete fsRequests[id]; resolve({ ok: false, error: 'Timeout' }) } }, 10000)
  })
}

// Requête téléchargement fichier
function fsReadFile(path) {
  return new Promise(resolve => {
    const id = genId()
    fsRequests[id] = resolve
    fsSend({ type: 'fs-read', id, path })
    setTimeout(() => { if (fsRequests[id]) { delete fsRequests[id]; resolve({ ok: false, error: 'Timeout' }) } }, 120000)
  })
}

// Traite les messages reçus du host via DataChannel
function handleHostMessage(msg) {
  if (msg.type === 'fs-list-res') {
    const cb = fsRequests[msg.id]; delete fsRequests[msg.id]; if (cb) cb(msg)
  } else if (msg.type === 'fs-read-start') {
    fileBuffers[msg.id] = { name: msg.name, total: msg.total, chunks: new Array(msg.total), received: 0, size: msg.size }
  } else if (msg.type === 'fs-read-chunk') {
    const buf = fileBuffers[msg.id]; if (!buf) return
    buf.chunks[msg.i] = msg.d; buf.received++
    // Mise à jour progression dans la liste
    const pct = Math.round(buf.received / buf.total * 100)
    fpSetStatus(`Téléchargement ${buf.name} — ${pct}%`)
    const row = fpList.querySelector(`[data-dl="${msg.id}"]`)
    if (row) { const bar = row.querySelector('.fp-progress'); if (bar) bar.style.width = pct + '%' }
  } else if (msg.type === 'fs-read-end') {
    const buf = fileBuffers[msg.id]; delete fileBuffers[msg.id]
    const cb  = fsRequests[msg.id]; delete fsRequests[msg.id]
    if (buf) {
      const base64 = buf.chunks.join('')
      if (cb) cb({ ok: true, name: buf.name, data: base64 })
    }
  } else if (msg.type === 'fs-read-err') {
    const cb = fsRequests[msg.id]; delete fsRequests[msg.id]
    if (cb) cb({ ok: false, error: msg.error })
  }
}

// Déclenche le téléchargement dans le navigateur Electron
function downloadBlob(name, base64) {
  const binary = atob(base64)
  const bytes  = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const blob = new Blob([bytes])
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

// Affiche le contenu d'un répertoire
async function fpNavigate(path) {
  fpSetStatus('Chargement...')
  fpList.innerHTML = ''
  const result = await fsListDir(path)
  if (!result.ok) { fpSetStatus(result.error || 'Erreur', 'err'); return }

  currentPath = result.path
  fpUpdateBreadcrumb(currentPath)
  fpSetStatus('', '')
  fpTitle.textContent = currentPath ? currentPath.split('\\').pop() || currentPath : 'Lecteurs'

  // Bouton parent
  if (currentPath) {
    const parentPath = currentPath.replace(/[/\\][^/\\]+[/\\]?$/, '') || ''
    const upRow = document.createElement('div')
    upRow.className = 'fp-entry'
    upRow.innerHTML = `<span class="fp-icon">↑</span><span class="fp-name" style="color:#888">Dossier parent</span>`
    upRow.addEventListener('click', () => fpNavigate(parentPath))
    fpList.appendChild(upRow)
  }

  if (!result.entries.length) {
    fpList.innerHTML += '<div style="padding:16px;color:#555;text-align:center">Dossier vide</div>'
    return
  }

  for (const entry of result.entries) {
    const row = document.createElement('div')
    row.className = 'fp-entry'
    row.style.position = 'relative'
    const icon = entry.type === 'dir' || entry.type === 'drive' ? '📁' : getFileIcon(entry.name)
    row.innerHTML = `
      <span class="fp-icon">${icon}</span>
      <span class="fp-name">${entry.name}</span>
      <span class="fp-size">${fmtSize(entry.size)}</span>
    `
    if (entry.type === 'dir' || entry.type === 'drive') {
      row.addEventListener('click', () => fpNavigate(entry.path))
    } else {
      row.addEventListener('click', async () => {
        if (row.classList.contains('downloading')) return
        row.classList.add('downloading')
        const dlId = genId()
        row.dataset.dl = dlId
        const bar = document.createElement('div'); bar.className = 'fp-progress'; bar.style.width = '0%'
        row.appendChild(bar)
        fpSetStatus(`Téléchargement ${entry.name}...`)
        // Réutilise fsReadFile mais avec le suivi de progression via fileBuffers
        const id = genId()
        fsRequests[id] = (res) => {
          row.classList.remove('downloading')
          bar.remove()
          if (res.ok) { fpSetStatus(`✓ ${entry.name} téléchargé`, 'ok'); downloadBlob(res.name, res.data) }
          else { fpSetStatus(`Erreur : ${res.error}`, 'err') }
        }
        // Override pour que le suivi de progression pointe sur cette ligne
        row.dataset.dl = id
        fsSend({ type: 'fs-read', id, path: entry.path })
      })
    }
    fpList.appendChild(row)
  }
}

function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase()
  const icons = { pdf:'📄', doc:'📝', docx:'📝', xls:'📊', xlsx:'📊', ppt:'📊', pptx:'📊',
    jpg:'🖼', jpeg:'🖼', png:'🖼', gif:'🖼', bmp:'🖼', svg:'🖼', webp:'🖼',
    mp4:'🎬', avi:'🎬', mkv:'🎬', mov:'🎬', mp3:'🎵', wav:'🎵', flac:'🎵',
    zip:'📦', rar:'📦', '7z':'📦', exe:'⚙️', msi:'⚙️', txt:'📃', csv:'📃',
    js:'💻', ts:'💻', py:'💻', html:'💻', css:'💻', json:'💻' }
  return icons[ext] || '📄'
}

function fpUpdateBreadcrumb(path) {
  fpBreadcrumb.innerHTML = ''
  const root = document.createElement('span')
  root.className = 'crumb'; root.textContent = '🖥 PC'
  root.addEventListener('click', () => fpNavigate(''))
  fpBreadcrumb.appendChild(root)
  if (!path) return

  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  let built = ''
  for (const part of parts) {
    built = built ? built + '\\' + part : part + '\\'
    const sep = document.createElement('span'); sep.className = 'crumb-sep'; sep.textContent = ' › '
    const crumb = document.createElement('span'); crumb.className = 'crumb'
    crumb.textContent = part
    const p = built
    crumb.addEventListener('click', () => fpNavigate(p))
    fpBreadcrumb.appendChild(sep)
    fpBreadcrumb.appendChild(crumb)
  }
}

function fpSetStatus(msg, type = '') {
  fpStatus.textContent = msg; fpStatus.className = type
}

// Toggle panel
btnExplorer.addEventListener('click', () => {
  if (filePanel.classList.contains('open')) {
    filePanel.classList.remove('open')
  } else {
    filePanel.classList.add('open')
    if (!fpList.children.length) fpNavigate('')
  }
})
btnFpClose.addEventListener('click', () => filePanel.classList.remove('open'))

// ── Mode contrôle ────────────────────────────────────────────────────────────
function setControlMode(enabled) {
  controlEnabled = enabled
  videoEl.classList.toggle('released', !enabled)
  overlayReleased.classList.toggle('visible', !enabled)
  if (enabled) videoEl.focus()
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  e.preventDefault()
  const now = Date.now()
  if (now - lastEscTime < DOUBLE_ESC_MS) {
    clearTimeout(toastTimer); toastEsc.classList.remove('visible'); lastEscTime = 0
    if (controlEnabled) { setControlMode(false); window.remotelink.setFullScreen(false) }
    else { setControlMode(true); window.remotelink.setFullScreen(true) }
  } else {
    lastEscTime = now
    if (controlEnabled && isConnected) {
      toastEsc.classList.add('visible')
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => { toastEsc.classList.remove('visible'); lastEscTime = 0 }, DOUBLE_ESC_MS + 300)
    }
  }
}, true)

// ── Inputs souris/clavier ────────────────────────────────────────────────────
function sendInput(data) {
  if (!controlEnabled) return
  if (inputChannel && inputChannel.readyState === 'open') inputChannel.send(JSON.stringify(data))
}

function attachInputListeners() {
  videoEl.addEventListener('contextmenu', e => e.preventDefault())
  videoEl.addEventListener('mousemove', (e) => {
    const now = Date.now(); if (now - lastMoveTime < MOVE_THROTTLE_MS) return; lastMoveTime = now
    sendInput({ type: 'mousemove', x: e.offsetX / videoEl.clientWidth, y: e.offsetY / videoEl.clientHeight })
  })
  videoEl.addEventListener('mousedown', (e) => {
    if (!controlEnabled) return; e.preventDefault()
    sendInput({ type: 'mousedown', button: e.button, x: e.offsetX / videoEl.clientWidth, y: e.offsetY / videoEl.clientHeight })
    videoEl.focus()
  })
  videoEl.addEventListener('mouseup', (e) => {
    sendInput({ type: 'mouseup', button: e.button, x: e.offsetX / videoEl.clientWidth, y: e.offsetY / videoEl.clientHeight })
  })
  videoEl.addEventListener('wheel', (e) => {
    if (!controlEnabled) return; e.preventDefault()
    sendInput({ type: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY })
  }, { passive: false })
  videoEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return
    if (!controlEnabled) return
    if (e.ctrlKey && ['w','r','t'].includes(e.key.toLowerCase())) return
    e.preventDefault()
    sendInput({ type: 'keydown', key: e.key, code: e.code, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey })
  })
}

// ── Stats HUD ────────────────────────────────────────────────────────────────
function startStats(pc) {
  let lb = 0
  statsInterval = setInterval(async () => {
    if (!pc) return
    const stats = await pc.getStats()
    stats.forEach(r => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') {
        hudEl.textContent = `${Math.round(r.framesPerSecond||0)}fps  ${Math.round((r.bytesReceived-lb)*8/1000)}kbps`
        lb = r.bytesReceived
      }
    })
  }, 1000)
}
function stopStats() { clearInterval(statsInterval); statsInterval = null }

// ── Vues ─────────────────────────────────────────────────────────────────────
function showStreamView() {
  connectViewEl.style.display = 'none'; streamViewEl.classList.add('active')
  window.remotelink.setFullScreen(true); setControlMode(true); videoEl.focus()
}
function showConnectView() {
  window.remotelink.setFullScreen(false); streamViewEl.classList.remove('active')
  connectViewEl.style.display = ''; btnEl.disabled = false; setStatus('Prêt')
  hudEl.textContent = '-- fps'; reconnectBadge.classList.remove('visible')
  overlayReleased.classList.remove('visible'); filePanel.classList.remove('open')
  fpList.innerHTML = ''; isConnected = false
}
function setStatus(msg, type = '') { statusEl.textContent = msg; statusEl.className = type }

// ── Loaders ──────────────────────────────────────────────────────────────────
function loadSocketIO() {
  return new Promise((resolve, reject) => {
    if (typeof io !== 'undefined') return resolve()
    const s = document.createElement('script')
    s.src = './node_modules/socket.io-client/dist/socket.io.min.js'
    s.onload = resolve; s.onerror = reject; document.head.appendChild(s)
  })
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
function cleanup(resetUI = true) {
  stopStats(); inputChannel = null
  if (peerConnection) { peerConnection.close(); peerConnection = null }
  if (resetUI) showConnectView()
}

function scheduleReconnect() {
  reconnectBadge.classList.add('visible')
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    if (socket?.connected) socket.emit('register-viewer'); else showConnectView()
  }, 3000)
}

// ── WebRTC ────────────────────────────────────────────────────────────────────
function startWebRTC() {
  peerConnection = new RTCPeerConnection(STUN_SERVERS)

  peerConnection.ondatachannel = (e) => {
    inputChannel = e.channel
    inputChannel.onclose = () => { inputChannel = null }
    // Reçoit les réponses FS du host
    inputChannel.onmessage = (ev) => {
      try { handleHostMessage(JSON.parse(ev.data)) } catch {}
    }
  }

  peerConnection.onicecandidate = ({ candidate }) => { if (candidate) socket.emit('ice-candidate', candidate) }

  peerConnection.ontrack = (event) => {
    videoEl.srcObject = event.streams[0]
    showStreamView(); isConnected = true
    attachInputListeners(); startStats(peerConnection)
  }

  peerConnection.onconnectionstatechange = () => {
    const s = peerConnection.connectionState
    if (s === 'failed' || s === 'disconnected') { stopStats(); cleanup(false); scheduleReconnect() }
  }
}

// ── Connexion ─────────────────────────────────────────────────────────────────
async function connect() {
  btnEl.disabled = true; setStatus('Chargement...')
  try { await loadSocketIO() } catch { setStatus('Erreur socket.io', 'error'); btnEl.disabled = false; return }
  if (socket) { socket.disconnect(); socket = null }
  socket = io(SIGNALING_URL, { reconnection: true, reconnectionDelay: 2000 })
  socket.on('connect',           () => { setStatus('Connecté...'); socket.emit('register-viewer') })
  socket.on('registered',        () => { if (!isConnected) setStatus('En attente du PC hôte...') })
  socket.on('host-available',    () => { reconnectBadge.classList.remove('visible'); setStatus('WebRTC...'); startWebRTC() })
  socket.on('host-disconnected', () => { stopStats(); cleanup(true); setStatus('PC hôte déconnecté', 'error') })
  socket.on('offer', async (data) => {
    if (!peerConnection) return
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data))
    const answer = await peerConnection.createAnswer()
    await peerConnection.setLocalDescription(answer); socket.emit('answer', answer)
  })
  socket.on('ice-candidate', async (data) => {
    if (peerConnection && data) try { await peerConnection.addIceCandidate(new RTCIceCandidate(data)) } catch {}
  })
  socket.on('disconnect',    () => { if (!isConnected) { setStatus('Déconnecté', 'error'); btnEl.disabled = false } })
  socket.on('connect_error', () => { if (!isConnected) { setStatus('Erreur connexion', 'error'); btnEl.disabled = false } })
}

btnEl.addEventListener('click', connect)
