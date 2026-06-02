const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const cors = require('cors')

const app = express()
app.use(cors())

const server = http.createServer(app)
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
})

// Un seul hôte possible, un seul viewer à la fois
let hostSocket = null
let viewerSocket = null

app.get('/', (req, res) => {
  res.send('RemoteLink signaling server OK')
})

io.on('connection', (socket) => {
  console.log(`[+] Connecté : ${socket.id}`)

  // Le PC hôte s'enregistre
  socket.on('register-host', () => {
    hostSocket = socket
    console.log(`[HOST] Enregistré : ${socket.id}`)
    socket.emit('registered', { role: 'host' })
    if (viewerSocket) {
      viewerSocket.emit('host-available')
    }
  })

  // La tablette se connecte
  socket.on('register-viewer', () => {
    viewerSocket = socket
    console.log(`[VIEWER] Enregistré : ${socket.id}`)
    socket.emit('registered', { role: 'viewer' })
    if (hostSocket) {
      socket.emit('host-available')
      hostSocket.emit('viewer-ready') // prévient le host qu'un viewer est prêt
    }
  })

  // Relais WebRTC : offer (host → viewer)
  socket.on('offer', (data) => {
    console.log('[SIGNAL] offer transmis')
    if (viewerSocket) viewerSocket.emit('offer', data)
  })

  // Relais WebRTC : answer (viewer → host)
  socket.on('answer', (data) => {
    console.log('[SIGNAL] answer transmis')
    if (hostSocket) hostSocket.emit('answer', data)
  })

  // Relais WebRTC : ICE candidates (bidirectionnel)
  socket.on('ice-candidate', (data) => {
    if (socket === hostSocket && viewerSocket) {
      viewerSocket.emit('ice-candidate', data)
    } else if (socket === viewerSocket && hostSocket) {
      hostSocket.emit('ice-candidate', data)
    }
  })

  // Déconnexion
  socket.on('disconnect', () => {
    if (socket === hostSocket) {
      console.log('[HOST] Déconnecté')
      hostSocket = null
      if (viewerSocket) viewerSocket.emit('host-disconnected')
    }
    if (socket === viewerSocket) {
      console.log('[VIEWER] Déconnecté')
      viewerSocket = null
    }
  })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`Signaling server démarré sur le port ${PORT}`)
})
