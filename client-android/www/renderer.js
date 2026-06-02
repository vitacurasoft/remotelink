const SIGNALING_URL = 'https://remotelink-h336.onrender.com'
const STUN_SERVERS  = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] }

// ── DOM ──────────────────────────────────────────────────────────────────────
const connectViewEl   = document.getElementById('connect-view')
const streamViewEl    = document.getElementById('stream-view')
const statusEl        = document.getElementById('status')
const videoEl         = document.getElementById('screen')
const btnEl           = document.getElementById('btn-connect')
const hudEl           = document.getElementById('hud')
const overlayReleased = document.getElementById('overlay-released')
const reconnectBadge  = document.getElementById('reconnect-badge')
const btnCtrl         = document.getElementById('btn-ctrl')
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
let controlEnabled = true
let lastMoveTime = 0
const MOVE_THROTTLE_MS = 40

// ── Touch state ───────────────────────────────────────────────────────────────
let touchActive = false, touchStartTime = 0
let touchStartX = 0, touchStartY = 0, lastTouchX = 0, lastTouchY = 0
let longPressTimer = null
let lastTwoFingerY = null
const LONG_PRESS_MS    = 500
const TAP_THRESHOLD_PX = 12
const TAP_THRESHOLD_MS = 300

// ── Explorateur fichiers ──────────────────────────────────────────────────────
let fsRequests = {}, fileBuffers = {}, reqCounter = 0, currentPath = ''
function genId() { return 'r' + (++reqCounter) }
function fmtSize(b) {
  if (!b) return ''
  if (b < 1024) return b + ' o'
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' Ko'
  if (b < 1024*1024*1024) return (b/1024/1024).toFixed(1) + ' Mo'
  return (b/1024/1024/1024).toFixed(1) + ' Go'
}
function fsSend(msg) {
  if (inputChannel && inputChannel.readyState === 'open') inputChannel.send(JSON.stringify(msg))
}
function fsListDir(path) {
  return new Promise(resolve => {
    const id = genId(); fsRequests[id] = resolve
    fsSend({ type: 'fs-list', id, path: path || '' })
    setTimeout(() => { if (fsRequests[id]) { delete fsRequests[id]; resolve({ ok: false, error: 'Timeout' }) } }, 10000)
  })
}
function handleHostMessage(msg) {
  if (msg.type === 'fs-list-res') {
    const cb = fsRequests[msg.id]; delete fsRequests[msg.id]; if (cb) cb(msg)
  } else if (msg.type === 'fs-read-start') {
    fileBuffers[msg.id] = { name: msg.name, total: msg.total, chunks: new Array(msg.total), received: 0, size: msg.size }
  } else if (msg.type === 'fs-read-chunk') {
    const buf = fileBuffers[msg.id]; if (!buf) return
    buf.chunks[msg.i] = msg.d; buf.received++
    const pct = Math.round(buf.received / buf.total * 100)
    fpSetStatus(`Téléchargement ${buf.name} — ${pct}%`)
    const row = fpList.querySelector(`[data-dl="${msg.id}"]`)
    if (row) { const bar = row.querySelector('.fp-progress'); if (bar) bar.style.width = pct + '%' }
  } else if (msg.type === 'fs-read-end') {
    const buf = fileBuffers[msg.id]; delete fileBuffers[msg.id]
    const cb  = fsRequests[msg.id]; delete fsRequests[msg.id]
    if (buf && cb) cb({ ok: true, name: buf.name, data: buf.chunks.join('') })
  } else if (msg.type === 'fs-read-err') {
    const cb = fsRequests[msg.id]; delete fsRequests[msg.id]; if (cb) cb({ ok: false, error: msg.error })
  }
}
function downloadBlob(name, base64) {
  const binary = atob(base64), bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const url = URL.createObjectURL(new Blob([bytes]))
  const a = document.createElement('a'); a.href = url; a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
async function fpNavigate(path) {
  fpSetStatus('Chargement...'); fpList.innerHTML = ''
  const result = await fsListDir(path)
  if (!result.ok) { fpSetStatus(result.error || 'Erreur', 'err'); return }
  currentPath = result.path
  fpUpdateBreadcrumb(currentPath); fpSetStatus('')
  fpTitle.textContent = currentPath ? currentPath.split('\\').pop() || currentPath : 'Lecteurs'
  if (currentPath) {
    const parentPath = currentPath.replace(/[/\\][^/\\]+[/\\]?$/, '') || ''
    const upRow = document.createElement('div')
    upRow.className = 'fp-entry'
    upRow.innerHTML = `<span class="fp-icon">↑</span><span class="fp-name" style="color:#888">Dossier parent</span>`
    upRow.addEventListener('click', () => fpNavigate(parentPath))
    fpList.appendChild(upRow)
  }
  if (!result.entries?.length) { fpList.innerHTML += '<div style="padding:16px;color:#555;text-align:center">Dossier vide</div>'; return }
  for (const entry of result.entries) {
    const row = document.createElement('div'); row.className = 'fp-entry'; row.style.position = 'relative'
    const icon = entry.type === 'dir' || entry.type === 'drive' ? '📁' : getFileIcon(entry.name)
    row.innerHTML = `<span class="fp-icon">${icon}</span><span class="fp-name">${entry.name}</span><span class="fp-size">${fmtSize(entry.size)}</span>`
    if (entry.type === 'dir' || entry.type === 'drive') {
      row.addEventListener('click', () => fpNavigate(entry.path))
    } else {
      row.addEventListener('click', async () => {
        if (row.classList.contains('downloading')) return
        row.classList.add('downloading')
        const id = genId(); row.dataset.dl = id
        const bar = document.createElement('div'); bar.className = 'fp-progress'; bar.style.width = '0%'; row.appendChild(bar)
        fpSetStatus(`Téléchargement ${entry.name}...`)
        fsRequests[id] = (res) => {
          row.classList.remove('downloading'); bar.remove()
          if (res.ok) { fpSetStatus(`✓ ${entry.name}`, 'ok'); downloadBlob(res.name, res.data) }
          else fpSetStatus(`Erreur : ${res.error}`, 'err')
        }
        fsSend({ type: 'fs-read', id, path: entry.path })
      })
    }
    fpList.appendChild(row)
  }
}
function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase()
  const m = { pdf:'📄',doc:'📝',docx:'📝',xls:'📊',xlsx:'📊',jpg:'🖼',jpeg:'🖼',png:'🖼',gif:'🖼',mp4:'🎬',mkv:'🎬',mp3:'🎵',zip:'📦',rar:'📦',exe:'⚙️',txt:'📃' }
  return m[ext] || '📄'
}
function fpUpdateBreadcrumb(path) {
  fpBreadcrumb.innerHTML = ''
  const root = document.createElement('span'); root.className = 'crumb'; root.textContent = '🖥 PC'
  root.addEventListener('click', () => fpNavigate('')); fpBreadcrumb.appendChild(root)
  if (!path) return
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean); let built = ''
  for (const part of parts) {
    built = built ? built + '\\' + part : part + '\\'
    const sep = document.createElement('span'); sep.className = 'crumb-sep'; sep.textContent = ' › '
    const crumb = document.createElement('span'); crumb.className = 'crumb'; crumb.textContent = part
    const p = built; crumb.addEventListener('click', () => fpNavigate(p))
    fpBreadcrumb.appendChild(sep); fpBreadcrumb.appendChild(crumb)
  }
}
function fpSetStatus(msg, type = '') { fpStatus.textContent = msg; fpStatus.className = type }

btnExplorer.addEventListener('click', () => {
  if (filePanel.classList.contains('open')) filePanel.classList.remove('open')
  else { filePanel.classList.add('open'); if (!fpList.children.length) fpNavigate('') }
})
btnFpClose.addEventListener('click', () => filePanel.classList.remove('open'))

// ── Contrôle ON/OFF ───────────────────────────────────────────────────────────
function setControlMode(enabled) {
  controlEnabled = enabled
  btnCtrl.classList.toggle('released', !enabled)
  btnCtrl.textContent = enabled ? '🖱' : '✋'
  overlayReleased.classList.toggle('visible', !enabled)
}
btnCtrl.addEventListener('click', () => {
  setControlMode(!controlEnabled)
  if (controlEnabled) requestFullscreen()
})

function requestFullscreen() {
  const el = document.documentElement
  if (el.requestFullscreen) el.requestFullscreen()
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen()
}

// ── Input souris (envoi) ──────────────────────────────────────────────────────
function sendInput(data) {
  if (!controlEnabled) return
  if (inputChannel && inputChannel.readyState === 'open') inputChannel.send(JSON.stringify(data))
}

// ── Touch → Mouse ─────────────────────────────────────────────────────────────
function attachTouchListeners() {

  videoEl.addEventListener('touchstart', (e) => {
    e.preventDefault()
    if (e.touches.length === 1) {
      const t = e.touches[0]
      touchActive = true; touchStartTime = Date.now()
      touchStartX = t.clientX; touchStartY = t.clientY
      lastTouchX  = t.clientX; lastTouchY  = t.clientY
      const x = t.clientX / videoEl.clientWidth
      const y = t.clientY / videoEl.clientHeight
      sendInput({ type: 'mousemove', x, y })
      // Long press → clic droit
      longPressTimer = setTimeout(() => {
        if (navigator.vibrate) navigator.vibrate(40)
        sendInput({ type: 'mousedown', button: 2, x, y })
        sendInput({ type: 'mouseup',   button: 2, x, y })
        touchActive = false
      }, LONG_PRESS_MS)
    } else if (e.touches.length === 2) {
      clearTimeout(longPressTimer); touchActive = false
      lastTwoFingerY = (e.touches[0].clientY + e.touches[1].clientY) / 2
    }
  }, { passive: false })

  videoEl.addEventListener('touchmove', (e) => {
    e.preventDefault()
    clearTimeout(longPressTimer)
    if (e.touches.length === 1 && touchActive) {
      const t = e.touches[0]
      lastTouchX = t.clientX; lastTouchY = t.clientY
      const now = Date.now()
      if (now - lastMoveTime >= MOVE_THROTTLE_MS) {
        lastMoveTime = now
        sendInput({ type: 'mousemove', x: t.clientX / videoEl.clientWidth, y: t.clientY / videoEl.clientHeight })
      }
    } else if (e.touches.length === 2) {
      const avgY = (e.touches[0].clientY + e.touches[1].clientY) / 2
      if (lastTwoFingerY !== null) {
        const delta = -(avgY - lastTwoFingerY) * 4
        sendInput({ type: 'wheel', deltaX: 0, deltaY: delta })
      }
      lastTwoFingerY = avgY
    }
  }, { passive: false })

  videoEl.addEventListener('touchend', (e) => {
    e.preventDefault()
    clearTimeout(longPressTimer)
    lastTwoFingerY = null
    if (!touchActive) return
    const dx = lastTouchX - touchStartX, dy = lastTouchY - touchStartY
    const dist = Math.sqrt(dx*dx + dy*dy)
    const duration = Date.now() - touchStartTime
    if (dist < TAP_THRESHOLD_PX && duration < TAP_THRESHOLD_MS) {
      const x = lastTouchX / videoEl.clientWidth, y = lastTouchY / videoEl.clientHeight
      sendInput({ type: 'mousedown', button: 0, x, y })
      setTimeout(() => sendInput({ type: 'mouseup', button: 0, x, y }), 60)
    }
    touchActive = false
  }, { passive: false })
}

// ── Stats HUD ─────────────────────────────────────────────────────────────────
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

// ── Vues ──────────────────────────────────────────────────────────────────────
function showStreamView() {
  connectViewEl.style.display = 'none'; streamViewEl.classList.add('active')
  requestFullscreen(); setControlMode(true)
}
function showConnectView() {
  if (document.exitFullscreen) document.exitFullscreen().catch(() => {})
  streamViewEl.classList.remove('active'); connectViewEl.style.display = ''
  btnEl.disabled = false; setStatus('Prêt'); hudEl.textContent = '-- fps'
  reconnectBadge.classList.remove('visible'); filePanel.classList.remove('open')
  fpList.innerHTML = ''; isConnected = false
}
function setStatus(msg, type = '') { statusEl.textContent = msg; statusEl.className = type }

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
    inputChannel.onclose   = () => { inputChannel = null }
    inputChannel.onmessage = (ev) => { try { handleHostMessage(JSON.parse(ev.data)) } catch {} }
  }
  peerConnection.onicecandidate = ({ candidate }) => { if (candidate) socket.emit('ice-candidate', candidate) }
  peerConnection.ontrack = (event) => {
    videoEl.srcObject = event.streams[0]
    showStreamView(); isConnected = true
    attachTouchListeners(); startStats(peerConnection)
  }
  peerConnection.onconnectionstatechange = () => {
    const s = peerConnection.connectionState
    if (s === 'failed' || s === 'disconnected') { stopStats(); cleanup(false); scheduleReconnect() }
  }
}

// ── Connexion ─────────────────────────────────────────────────────────────────
async function connect() {
  btnEl.disabled = true; setStatus('Connexion...')
  if (socket) { socket.disconnect(); socket = null }
  socket = io(SIGNALING_URL, { reconnection: true, reconnectionDelay: 2000 })
  socket.on('connect',           () => { setStatus('Connecté...'); socket.emit('register-viewer') })
  socket.on('registered',        () => { if (!isConnected) setStatus('En attente du PC hôte...') })
  socket.on('host-available',    () => { reconnectBadge.classList.remove('visible'); setStatus('WebRTC...'); startWebRTC() })
  socket.on('host-disconnected', () => { stopStats(); cleanup(true); setStatus('PC hôte déconnecté', 'error') })
  socket.on('offer', async (data) => {
    if (!peerConnection) return
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data))
    const ans = await peerConnection.createAnswer()
    await peerConnection.setLocalDescription(ans); socket.emit('answer', ans)
  })
  socket.on('ice-candidate', async (d) => {
    if (peerConnection && d) try { await peerConnection.addIceCandidate(new RTCIceCandidate(d)) } catch {}
  })
  socket.on('disconnect',    () => { if (!isConnected) { setStatus('Déconnecté', 'error'); btnEl.disabled = false } })
  socket.on('connect_error', () => { if (!isConnected) { setStatus('Erreur connexion', 'error'); btnEl.disabled = false } })
}

btnEl.addEventListener('click', connect)
