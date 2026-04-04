require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { verifyToken } = require('@clerk/backend');

const app = express();

const PORT = Number(process.env.PORT || 3001);
const CLIENT_URL = process.env.CLIENT_URL;
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;

if (!CLIENT_URL) {
  throw new Error('Missing CLIENT_URL in realtime-server/.env');
}

app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'realtime-server' });
});

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: CLIENT_URL,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;

    if (!token) {
      return next(new Error('Authentication token missing'));
    }

    if (!CLERK_SECRET_KEY) {
      return next(new Error('Server authentication is not configured'));
    }

    const verified = await verifyToken(token, {
      secretKey: CLERK_SECRET_KEY,
    });

    socket.data.userId = verified.sub;
    return next();
  } catch (error) {
    return next(new Error('Invalid authentication token'));
  }
});

io.on('connection', (socket) => {
  socket.on('join_game', ({ gameId }) => {
    if (!gameId) return;
    const roomId = String(gameId);
    socket.join(roomId);
    socket.to(roomId).emit('player_joined', { gameId: roomId, userId: socket.data.userId });
  });

  socket.on('move', ({ gameId, move }) => {
    if (!gameId || !move) return;
    const roomId = String(gameId);
    socket.to(roomId).emit('move', {
      gameId: roomId,
      move,
      userId: socket.data.userId,
      createdAt: new Date().toISOString(),
    });
  });

  socket.on('leave_game', ({ gameId }) => {
    if (!gameId) return;
    const roomId = String(gameId);
    socket.leave(roomId);
    socket.to(roomId).emit('player_left', { gameId: roomId, userId: socket.data.userId });
  });

  socket.on('disconnect', () => {
    // Connection lifecycle event required for clients to handle disconnects.
  });
});

httpServer.listen(PORT, () => {
  console.log(`[realtime-server] listening on port ${PORT}`);
});
