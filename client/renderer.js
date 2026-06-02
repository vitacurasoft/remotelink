// Serveur de signalisation hébergé sur Render
const SIGNALING_URL = 'https://remotelink-h336.onrender.com'

const STUN_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
}

const statusEl  = document.getElementById('status')
const videoEl   = document.getElementById('screen')
const btnEl     = document.getElementById('btn-connect')

let socket         = null
let peerConnection = null
let inputChannel   = null

// Throttle pour mousemove (max ~20/sec)
let lastMoveTime = 0
const MOVE_THROTTLE_MS = 50

function setStatus(msg, type = '') {
  statusEl.textContent = msg
  statusEl.className = type
}

function loadSocketIO() {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = './node_modules/socket.io-client/dist/socket.io.min.js'
    script.onload = resolve
    script.onerror = reject
    document.head.appendChild(script)
  })
}

// Envoie un événement clavier/souris via DataChannel
function sendInput(data) {
  if (inputChannel && inputChannel.readyState === 'open') {
    inputChannel.send(JSON.stringify(data))
  }
}

// --- Listeners événements sur la vidéo ---

function attachInputListeners() {
  // Empêche le menu contextuel natif sur clic droit
  videoEl.addEventListener('contextmenu', e => e.preventDefault())

  // Mouvement souris (throttlé)
  videoEl.addEventListener('mousemove', (e) => {
    const now = Date.now()
    if (now - lastMoveTime < MOVE_THROTTLE_MS) return
    lastMoveTime = now
    sendInput({
      type: 'mousemove',
      x: e.offsetX / videoEl.clientWidth,
      y: e.offsetY / videoEl.clientHeight
    })
  })

  // Clic souris down
  videoEl.addEventListener('mousedown', (e) => {
    e.preventDefault()
    sendInput({
      type: 'mousedown',
      button: e.button,
      x: e.offsetX / videoEl.clientWidth,
      y: e.offsetY / videoEl.clientHeight
    })
    videoEl.focus()  // pour capturer le clavier ensuite
  })

  // Clic souris up
  videoEl.addEventListener('mouseup', (e) => {
    sendInput({
      type: 'mouseup',
      button: e.button,
      x: e.offsetX / videoEl.clientWidth,
      y: e.offsetY / videoEl.clientHeight
    })
  })

  // Molette
  videoEl.addEventListener('wheel', (e) => {
    e.preventDefault()
    sendInput({ type: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY })
  }, { passive: false })

  // Clavier (capturé quand la vidéo est focusée)
  videoEl.addEventListener('keydown', (e) => {
    // Laisser passer F5 (reload), Ctrl+W etc. localement
    if (e.ctrlKey && ['w', 'r', 't'].includes(e.key.toLowerCase())) return
    e.preventDefault()
    sendInput({ type: 'keydown', key: e.key, code: e.code, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey })
  })
}

// --- WebRTC ---

function startWebRTC() {
  peerConnection = new RTCPeerConnection(STUN_SERVERS)

  // Reçoit le DataChannel ouvert par le host
  peerConnection.ondatachannel = (e) => {
    inputChannel = e.channel
    inputChannel.onopen  = () => console.log('[DataChannel] prêt')
    inputChannel.onclose = () => { inputChannel = null }
    console.log('[DataChannel] reçu :', e.channel.label)
  }

  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('ice-candidate', candidate)
  }

  peerConnection.ontrack = (event) => {
    videoEl.srcObject = event.streams[0]
    videoEl.classList.add('active')
    btnEl.style.display = 'none'
    setStatus('Connecté', 'connected')
    attachInputListeners()
  }

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState
    if (state === 'failed' || state === 'disconnected') {
      setStatus('Connexion perdue', 'error')
      cleanup()
    }
  }
}

function cleanup() {
  inputChannel   = null
  if (peerConnection) { peerConnection.close(); peerConnection = null }
  videoEl.srcObject = null
  videoEl.classList.remove('active')
  btnEl.style.display = ''
  btnEl.disabled = false
}

// --- Connexion principale ---

async function connect() {
  btnEl.disabled = true
  setStatus('Connexion au serveur...')
  try { await loadSocketIO() }
  catch { setStatus('Impossible de charger socket.io-client', 'error'); btnEl.disabled = false; return }

  socket = io(SIGNALING_URL)

  socket.on('connect',    () => { setStatus('Connecté au serveur...'); socket.emit('register-viewer') })
  socket.on('registered', () => setStatus('En attente du PC hôte...'))
  socket.on('host-available', () => { setStatus('PC hôte trouvé — WebRTC...'); startWebRTC() })

  socket.on('host-disconnected', () => { setStatus('PC hôte déconnecté', 'error'); cleanup() })

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

  socket.on('disconnect',    () => { setStatus('Déconnecté', 'error'); cleanup() })
  socket.on('connect_error', () => { setStatus('Erreur de connexion', 'error'); btnEl.disabled = false })
}

btnEl.addEventListener('click', connect)
