const SIGNALING_URL = 'https://remotelink-h336.onrender.com'

const STUN_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
}

const statusEl    = document.getElementById('status')
const indicatorEl = document.getElementById('indicator')

let socket         = null
let peerConnection = null
let localStream    = null
let inputChannel   = null

function setStatus(msg, type = '') {
  statusEl.textContent = msg
  statusEl.className   = type
  indicatorEl.className = (type === 'connected') ? 'active' : ''
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

async function getScreenStream() {
  const sourceId = await window.remotelink.getScreenSourceId()
  if (!sourceId) throw new Error('Aucun écran détecté')
  return await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 30
      }
    }
  })
}

function cleanup() {
  if (inputChannel)   { try { inputChannel.close() } catch {} inputChannel = null }
  if (localStream)    { localStream.getTracks().forEach(t => t.stop()); localStream = null }
  if (peerConnection) { peerConnection.close(); peerConnection = null }
}

async function startStreaming() {
  cleanup()
  setStatus('Capture de l\'écran...')

  try {
    localStream = await getScreenStream()
  } catch (e) {
    setStatus('Erreur capture : ' + e.message, 'error')
    return
  }

  setStatus('Création connexion WebRTC...')
  peerConnection = new RTCPeerConnection(STUN_SERVERS)

  // DataChannel pour recevoir les événements clavier/souris du viewer
  inputChannel = peerConnection.createDataChannel('input', { ordered: true })
  inputChannel.onopen    = () => console.log('[DataChannel] ouvert')
  inputChannel.onclose   = () => console.log('[DataChannel] fermé')
  inputChannel.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data)
      window.remotelink.sendInput(event)
    } catch {}
  }

  // Ajoute le stream vidéo
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream))

  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('ice-candidate', candidate)
  }

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState
    if (state === 'connected') {
      setStatus('Streaming en cours ●', 'connected')
    } else if (state === 'disconnected' || state === 'failed') {
      setStatus('Viewer déconnecté', 'error')
      cleanup()
    }
  }

  try {
    const offer = await peerConnection.createOffer()
    await peerConnection.setLocalDescription(offer)
    socket.emit('offer', offer)
    setStatus('En attente de la tablette...')
  } catch (e) {
    setStatus('Erreur offre WebRTC : ' + e.message, 'error')
  }
}

async function init() {
  setStatus('Chargement...')
  try { await loadSocketIO() }
  catch { setStatus('Erreur chargement socket.io', 'error'); return }

  socket = io(SIGNALING_URL)

  socket.on('connect',    () => { setStatus('Connexion...'); socket.emit('register-host') })
  socket.on('registered', () => setStatus('Prêt — en attente d\'un viewer...'))
  socket.on('viewer-ready', () => { setStatus('Viewer connecté — démarrage...'); startStreaming() })

  socket.on('answer', async (data) => {
    if (!peerConnection) return
    try { await peerConnection.setRemoteDescription(new RTCSessionDescription(data)) }
    catch (e) { setStatus('Erreur answer : ' + e.message, 'error') }
  })

  socket.on('ice-candidate', async (data) => {
    if (peerConnection && data) {
      try { await peerConnection.addIceCandidate(new RTCIceCandidate(data)) }
      catch {}
    }
  })

  socket.on('disconnect',    () => { setStatus('Déconnecté du serveur', 'error'); cleanup() })
  socket.on('connect_error', () => setStatus('Impossible de joindre le serveur', 'error'))
}

init()
