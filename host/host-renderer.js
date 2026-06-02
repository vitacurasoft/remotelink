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
let statsInterval  = null
let lastBytesSent  = 0

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

// Préférence codec H264 pour meilleure compression
function setH264Preference(pc) {
  try {
    const transceivers = pc.getTransceivers()
    for (const t of transceivers) {
      if (t.sender?.track?.kind === 'video') {
        const caps = RTCRtpSender.getCapabilities('video')
        if (!caps) continue
        const h264 = caps.codecs.filter(c => c.mimeType === 'video/H264')
        const rest = caps.codecs.filter(c => c.mimeType !== 'video/H264')
        t.setCodecPreferences([...h264, ...rest])
      }
    }
  } catch (e) {
    console.warn('[codec] setCodecPreferences:', e.message)
  }
}

// Limite le bitrate à 4 Mbps après connexion
async function applyBitrateLimit(pc) {
  try {
    const sender = pc.getSenders().find(s => s.track?.kind === 'video')
    if (!sender) return
    const params = sender.getParameters()
    if (!params.encodings?.length) params.encodings = [{}]
    params.encodings[0].maxBitrate    = 4_000_000  // 4 Mbps
    params.encodings[0].maxFramerate  = 30
    await sender.setParameters(params)
    console.log('[bitrate] 4 Mbps appliqué')
  } catch (e) {
    console.warn('[bitrate]', e.message)
  }
}

// Affiche fps + kbps dans le status
function startStats(pc) {
  lastBytesSent = 0
  statsInterval = setInterval(async () => {
    if (!pc || pc.connectionState !== 'connected') return
    const stats = await pc.getStats()
    stats.forEach(r => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') {
        const fps  = Math.round(r.framesPerSecond || 0)
        const kbps = Math.round((r.bytesSent - lastBytesSent) * 8 / 1000)
        lastBytesSent = r.bytesSent
        setStatus(`Streaming ● ${fps}fps  ${kbps > 0 ? kbps + 'kbps' : ''}`, 'connected')
      }
    })
  }, 1000)
}

function cleanup() {
  clearInterval(statsInterval); statsInterval = null
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

  peerConnection = new RTCPeerConnection(STUN_SERVERS)

  // DataChannel pour recevoir les événements clavier/souris
  inputChannel = peerConnection.createDataChannel('input', { ordered: true })
  inputChannel.onopen    = () => console.log('[DataChannel] ouvert')
  inputChannel.onmessage = (e) => {
    try { window.remotelink.sendInput(JSON.parse(e.data)) } catch {}
  }

  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream))

  // Applique la préférence H264 avant createOffer
  setH264Preference(peerConnection)

  peerConnection.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('ice-candidate', candidate)
  }

  peerConnection.onconnectionstatechange = async () => {
    const state = peerConnection.connectionState
    if (state === 'connected') {
      await applyBitrateLimit(peerConnection)
      startStats(peerConnection)
      window.remotelink.minimizeWindow()  // se minimise quand le streaming commence
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
    setStatus('Erreur offre : ' + e.message, 'error')
  }
}

async function init() {
  setStatus('Chargement...')
  try { await loadSocketIO() }
  catch { setStatus('Erreur chargement socket.io', 'error'); return }

  socket = io(SIGNALING_URL)

  socket.on('connect',      () => { setStatus('Connexion...'); socket.emit('register-host') })
  socket.on('registered',   () => setStatus('Prêt — en attente d\'un viewer...'))
  socket.on('viewer-ready', () => { setStatus('Viewer connecté — démarrage...'); startStreaming() })

  socket.on('answer', async (data) => {
    if (!peerConnection) return
    try { await peerConnection.setRemoteDescription(new RTCSessionDescription(data)) }
    catch (e) { setStatus('Erreur answer : ' + e.message, 'error') }
  })

  socket.on('ice-candidate', async (data) => {
    if (peerConnection && data) {
      try { await peerConnection.addIceCandidate(new RTCIceCandidate(data)) } catch {}
    }
  })

  socket.on('disconnect',    () => { setStatus('Déconnecté du serveur', 'error'); cleanup() })
  socket.on('connect_error', () => setStatus('Impossible de joindre le serveur', 'error'))
}

init()
