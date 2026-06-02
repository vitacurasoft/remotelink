const SIGNALING_URL = 'https://remotelink-h336.onrender.com'

const STUN_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
}

const connectViewEl   = document.getElementById('connect-view')
const streamViewEl    = document.getElementById('stream-view')
const statusEl        = document.getElementById('status')
const videoEl         = document.getElementById('screen')
const btnEl           = document.getElementById('btn-connect')
const hudEl           = document.getElementById('hud')
const reconnectBadge  = document.getElementById('reconnect-badge')

let socket          = null
let peerConnection  = null
let inputChannel    = null
let statsInterval   = null
let reconnectTimer  = null
let isConnected     = false

// Throttle mousemove (~20/sec)
let lastMoveTime = 0
const MOVE_THROTTLE_MS = 50

// ── Helpers UI ──────────────────────────────────────────────────────────────

function setStatus(msg, type = '') {
  statusEl.textContent = msg
  statusEl.className   = type
}

function showStreamView() {
  connectViewEl.style.display = 'none'
  streamViewEl.classList.add('active')
  videoEl.focus()
}

function showConnectView() {
  streamViewEl.classList.remove('active')
  connectViewEl.style.display = ''
  btnEl.disabled = false
  setStatus('Prêt')
  hudEl.textContent = '-- fps'
  reconnectBadge.classList.remove('visible')
  isConnected = false
}

// ── Socket.io loader ────────────────────────────────────────────────────────

function loadSocketIO() {
  return new Promise((resolve, reject) => {
    if (typeof io !== 'undefined') return resolve()
    const s = document.createElement('script')
    s.src = './node_modules/socket.io-client/dist/socket.io.min.js'
    s.onload = resolve; s.onerror = reject
    document.head.appendChild(s)
  })
}

// ── Input : envoi événements souris/clavier via DataChannel ────────────────

function sendInput(data) {
  if (inputChannel && inputChannel.readyState === 'open') {
    inputChannel.send(JSON.stringify(data))
  }
}

function attachInputListeners() {
  videoEl.addEventListener('contextmenu', e => e.preventDefault(), { once: false })

  videoEl.addEventListener('mousemove', (e) => {
    const now = Date.now()
    if (now - lastMoveTime < MOVE_THROTTLE_MS) return
    lastMoveTime = now
    sendInput({ type: 'mousemove',
      x: e.offsetX / videoEl.clientWidth,
      y: e.offsetY / videoEl.clientHeight })
  })

  videoEl.addEventListener('mousedown', (e) => {
    e.preventDefault()
    sendInput({ type: 'mousedown', button: e.button,
      x: e.offsetX / videoEl.clientWidth,
      y: e.offsetY / videoEl.clientHeight })
    videoEl.focus()
  })

  videoEl.addEventListener('mouseup', (e) => {
    sendInput({ type: 'mouseup', button: e.button,
      x: e.offsetX / videoEl.clientWidth,
      y: e.offsetY / videoEl.clientHeight })
  })

  videoEl.addEventListener('wheel', (e) => {
    e.preventDefault()
    sendInput({ type: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY })
  }, { passive: false })

  videoEl.addEventListener('keydown', (e) => {
    if (e.ctrlKey && ['w','r','t'].includes(e.key.toLowerCase())) return
    e.preventDefault()
    sendInput({ type: 'keydown', key: e.key, code: e.code,
      ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey })
  })
}

// ── Stats HUD ───────────────────────────────────────────────────────────────

function startStats(pc) {
  let lastBytesReceived = 0
  statsInterval = setInterval(async () => {
    if (!pc) return
    const stats = await pc.getStats()
    stats.forEach(r => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') {
        const fps  = Math.round(r.framesPerSecond || 0)
        const kbps = Math.round((r.bytesReceived - lastBytesReceived) * 8 / 1000)
        lastBytesReceived = r.bytesReceived
        hudEl.textContent = `${fps}fps  ${kbps}kbps`
      }
    })
  }, 1000)
}

function stopStats() {
  clearInterval(statsInterval)
  statsInterval = null
}

// ── WebRTC ──────────────────────────────────────────────────────────────────

function startWebRTC() {
  peerConnection = new RTCPeerConnection(STUN_SERVERS)

  peerConnection.ondatachannel = (e) => {
    inputChannel = e.channel
    inputChannel.onclose = () => { inputChannel = null }
  }

  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('ice-candidate', candidate)
  }

  peerConnection.ontrack = (event) => {
    videoEl.srcObject = event.streams[0]
    showStreamView()
    isConnected = true
    attachInputListeners()
    startStats(peerConnection)
  }

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState
    if (state === 'failed' || state === 'disconnected') {
      stopStats()
      reconnectBadge.classList.add('visible')
      cleanup(false)  // garde la stream-view visible
      scheduleReconnect()
    }
  }
}

// ── Reconnexion automatique ─────────────────────────────────────────────────

function scheduleReconnect() {
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    if (socket?.connected) {
      socket.emit('register-viewer')
    } else {
      showConnectView()
    }
  }, 3000)
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

function cleanup(resetUI = true) {
  stopStats()
  inputChannel = null
  if (peerConnection) { peerConnection.close(); peerConnection = null }
  if (resetUI) showConnectView()
}

// ── Connexion principale ────────────────────────────────────────────────────

async function connect() {
  btnEl.disabled = true
  setStatus('Chargement...')

  try { await loadSocketIO() }
  catch { setStatus('Impossible de charger socket.io', 'error'); btnEl.disabled = false; return }

  if (socket) { socket.disconnect(); socket = null }

  socket = io(SIGNALING_URL, { reconnection: true, reconnectionDelay: 2000 })

  socket.on('connect', () => {
    setStatus('Connecté au serveur...')
    socket.emit('register-viewer')
  })

  socket.on('registered', () => {
    if (!isConnected) setStatus('En attente du PC hôte...')
  })

  socket.on('host-available', () => {
    reconnectBadge.classList.remove('visible')
    setStatus('PC hôte trouvé — WebRTC...')
    startWebRTC()
  })

  socket.on('host-disconnected', () => {
    stopStats()
    cleanup(true)
    setStatus('PC hôte déconnecté', 'error')
  })

  socket.on('offer', async (data) => {
    if (!peerConnection) return
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data))
    const answer = await peerConnection.createAnswer()
    await peerConnection.setLocalDescription(answer)
    socket.emit('answer', answer)
  })

  socket.on('ice-candidate', async (data) => {
    if (peerConnection && data) {
      try { await peerConnection.addIceCandidate(new RTCIceCandidate(data)) } catch {}
    }
  })

  socket.on('disconnect', () => {
    if (!isConnected) { setStatus('Déconnecté', 'error'); btnEl.disabled = false }
  })

  socket.on('connect_error', () => {
    if (!isConnected) { setStatus('Erreur de connexion', 'error'); btnEl.disabled = false }
  })
}

btnEl.addEventListener('click', connect)
