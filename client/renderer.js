// URL du serveur de signalisation (à remplacer par l'URL Render après déploiement)
const SIGNALING_URL = 'http://localhost:3000'

const STUN_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
}

const statusEl  = document.getElementById('status')
const videoEl   = document.getElementById('screen')
const btnEl     = document.getElementById('btn-connect')

let socket = null
let peerConnection = null

function setStatus(msg, type = '') {
  statusEl.textContent = msg
  statusEl.className = type
}

// Charge socket.io-client depuis node_modules via le chemin relatif
function loadSocketIO() {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = '../node_modules/socket.io-client/dist/socket.io.min.js'
    script.onload = resolve
    script.onerror = reject
    document.head.appendChild(script)
  })
}

async function connect() {
  btnEl.disabled = true
  setStatus('Connexion au serveur...')

  try {
    await loadSocketIO()
  } catch {
    setStatus('Impossible de charger socket.io-client', 'error')
    btnEl.disabled = false
    return
  }

  socket = io(SIGNALING_URL)

  socket.on('connect', () => {
    setStatus('Connecté au serveur de signalisation')
    socket.emit('register-viewer')
  })

  socket.on('registered', ({ role }) => {
    setStatus(`En attente du PC hôte...`)
  })

  socket.on('host-available', () => {
    setStatus('PC hôte trouvé — initialisation WebRTC...')
    startWebRTC()
  })

  socket.on('host-disconnected', () => {
    setStatus('PC hôte déconnecté', 'error')
    cleanup()
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
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(data))
      } catch (e) {
        console.warn('ICE candidate ignoré:', e)
      }
    }
  })

  socket.on('disconnect', () => {
    setStatus('Déconnecté du serveur', 'error')
    cleanup()
  })

  socket.on('connect_error', () => {
    setStatus('Erreur de connexion au serveur', 'error')
    btnEl.disabled = false
  })
}

function startWebRTC() {
  peerConnection = new RTCPeerConnection(STUN_SERVERS)

  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('ice-candidate', candidate)
  }

  peerConnection.ontrack = (event) => {
    videoEl.srcObject = event.streams[0]
    videoEl.classList.add('active')
    btnEl.style.display = 'none'
    setStatus('Connecté', 'connected')
  }

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState
    if (state === 'failed' || state === 'disconnected') {
      setStatus('Connexion WebRTC perdue', 'error')
      cleanup()
    }
  }
}

function cleanup() {
  if (peerConnection) { peerConnection.close(); peerConnection = null }
  videoEl.srcObject = null
  videoEl.classList.remove('active')
  btnEl.style.display = ''
  btnEl.disabled = false
}

btnEl.addEventListener('click', connect)
