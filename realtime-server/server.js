require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { verifyToken } = require('@clerk/backend');

const app = express();

const PORT = Number(process.env.PORT || 3001);
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;

function normalizeOrigin(origin) {
  return String(origin || '').trim().replace(/\/$/, '');
}

function getAllowedOrigins() {
  return String(process.env.CLIENT_URL || '')
    .split(',')
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean);
}

const allowedOrigins = getAllowedOrigins();

if (allowedOrigins.length === 0) {
  throw new Error('Missing CLIENT_URL in realtime-server/.env');
}

function isOriginAllowed(origin) {
  if (!origin) return true; // allow non-browser/health tool requests
  const normalized = normalizeOrigin(origin);
  return allowedOrigins.includes(normalized);
}

const corsOptions = {
  origin(origin, callback) {
    if (isOriginAllowed(origin)) return callback(null, true);
    return callback(new Error('CORS origin not allowed'));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'realtime-server', allowedOrigins });
});

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin(origin, callback) {
      if (isOriginAllowed(origin)) return callback(null, true);
      return callback(new Error('Socket origin not allowed'));
    },
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
  socket.on('join_room', ({ roomId }) => {
    if (!roomId) return;
    socket.join(String(roomId));
  });

  socket.on('leave_room', ({ roomId }) => {
    if (!roomId) return;
    socket.leave(String(roomId));
  });

  socket.on('room_event', ({ roomId, event, payload }) => {
    if (!roomId || !event) return;
    io.to(String(roomId)).emit(String(event), {
      ...(payload && typeof payload === 'object' ? payload : {}),
      userId: socket.data.userId,
      sentAt: new Date().toISOString(),
    });
  });

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
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;
      socket.to(roomId).emit('player_disconnected', { roomId, userId: socket.data.userId });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`[realtime-server] listening on port ${PORT}`);
});
