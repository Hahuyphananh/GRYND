const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { verifyToken } = require('@clerk/backend');
require('dotenv').config();

const PORT = Number(process.env.PORT || 3001);
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;

const app = express();

app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
  }),
);

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'realtime-server' });
});

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: CLIENT_URL,
    credentials: true,
  },
});

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;

  if (!token) {
    return next(new Error('Unauthorized: missing auth token'));
  }

  if (!CLERK_SECRET_KEY) {
    return next(new Error('Unauthorized: missing CLERK_SECRET_KEY on realtime server'));
  }

  try {
    const claims = await verifyToken(token, {
      secretKey: CLERK_SECRET_KEY,
    });

    socket.data.userId = claims.sub;
    return next();
  } catch (error) {
    return next(new Error('Unauthorized: invalid auth token'));
  }
});

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id} user=${socket.data.userId}`);

  socket.on('join_game', ({ gameId }) => {
    if (!gameId) return;
    socket.join(gameId);
    socket.to(gameId).emit('player_joined', {
      gameId,
      socketId: socket.id,
      userId: socket.data.userId,
    });
  });

  socket.on('move', ({ gameId, move }) => {
    if (!gameId) return;
    socket.to(gameId).emit('move', {
      gameId,
      move,
      fromSocketId: socket.id,
      userId: socket.data.userId,
    });
  });

  socket.on('leave_game', ({ gameId }) => {
    if (!gameId) return;
    socket.leave(gameId);
    socket.to(gameId).emit('player_left', {
      gameId,
      socketId: socket.id,
      userId: socket.data.userId,
    });
  });

  socket.on('disconnect', () => {
    const joinedRooms = [...socket.rooms].filter((room) => room !== socket.id);

    joinedRooms.forEach((gameId) => {
      socket.to(gameId).emit('player_disconnected', {
        gameId,
        socketId: socket.id,
        userId: socket.data.userId,
      });
    });

    console.log(`Socket disconnected: ${socket.id}`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Realtime server listening on port ${PORT}`);
  console.log(`CORS enabled for CLIENT_URL=${CLIENT_URL}`);
});
