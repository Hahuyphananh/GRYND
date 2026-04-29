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
  if (!origin) return true;
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
  res.json({
    ok: true,
    service: 'realtime-server',
    allowedOrigins,
    clerkConfigured: Boolean(CLERK_SECRET_KEY),
    wsPath: '/socket.io',
  });
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

function createSeededRandom(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function generateRocks(seed, mapWidth, mapHeight, rockCount) {
  const rand = createSeededRandom(seed);
  return Array.from({ length: rockCount }).map((_, i) => {
    const size = 36 + rand() * 58;
    return {
      id: i,
      size,
      x: rand() * (mapWidth - size),
      y: rand() * (mapHeight - size),
    };
  });
}

const SPAWN_PADDING = 120;
const MIN_SPAWN_DISTANCE = 450;

function isSpawnBlockedByRock(point, rocks, tankRadius = 22) {
  return rocks.some((rock) => {
    const cx = rock.x + rock.size / 2;
    const cy = rock.y + rock.size / 2;
    const rockR = rock.size / 2;
    return Math.hypot(point.x - cx, point.y - cy) < rockR + tankRadius;
  });
}

function randomSpawnPosition(mapWidth, mapHeight) {
  return {
    x: SPAWN_PADDING + Math.random() * (mapWidth - SPAWN_PADDING * 2),
    y: SPAWN_PADDING + Math.random() * (mapHeight - SPAWN_PADDING * 2),
  };
}

function getSpawnPosition(room) {
  const occupied = Array.from(room.players.values()).filter(
    (state) => Number.isFinite(Number(state?.x)) && Number.isFinite(Number(state?.y))
  );

  for (let i = 0; i < 30; i += 1) {
    const candidate = randomSpawnPosition(room.mapWidth, room.mapHeight);
    const tooClose = occupied.some(
      (state) => Math.hypot(Number(state.x) - candidate.x, Number(state.y) - candidate.y) < MIN_SPAWN_DISTANCE
    );
    if (!tooClose && !isSpawnBlockedByRock(candidate, room.rocks)) {
      return candidate;
    }
  }

  for (let i = 0; i < 50; i += 1) {
    const candidate = randomSpawnPosition(room.mapWidth, room.mapHeight);
    if (!isSpawnBlockedByRock(candidate, room.rocks)) {
      return candidate;
    }
  }

  return { x: room.mapWidth / 2, y: room.mapHeight / 2 };
}

function lineIntersectsCircle(x1, y1, x2, y2, cx, cy, r) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const wx = cx - x1;
  const wy = cy - y1;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return (cx - x1) ** 2 + (cy - y1) ** 2 <= r * r;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  const px = x1 + vx * t;
  const py = y1 + vy * t;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

const TANK_ROOM_PREFIX = 'match:tanks:';
const TANK_TICK_MS = 33;
const tanksRooms = new Map();

function getSpeedFactor(y, mapHeight) {
  const waterY = mapHeight * 0.67;
  const shoreTransition = 130;
  if (y < waterY - shoreTransition) return 1;
  if (y >= waterY) return 0.56;
  const t = (y - (waterY - shoreTransition)) / shoreTransition;
  return 1 - t * 0.44;
}

function createTanksRoom(gameId, settings = {}) {
  const mapWidth = Number(settings.mapWidth) || 3000;
  const mapHeight = Number(settings.mapHeight) || 3000;
  const mapSeed = Number(settings.mapSeed) || 12345;
  const rockCount = Number(settings.rockCount) || 52;
  const maxHealth = Number(settings.maxHealth) || 5;
  return {
    gameId,
    mapWidth,
    mapHeight,
    maxHealth,
    rocks: generateRocks(mapSeed, mapWidth, mapHeight, rockCount),
    players: new Map(),
    bullets: [],
    nextBulletId: 1,
    lastTickAt: Date.now(),
    interval: null,
    mode: settings.mode === 'battle_royale' ? 'battle_royale' : 'duel',
  };
}

function ensureRoomLoop(room) {
  if (room.interval) return;
  room.interval = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(50, Math.max(10, now - room.lastTickAt));
    room.lastTickAt = now;
    const dtFactor = dt / 16.6667;
    const tankRadius = 22;
    const speed = 2;
    const bulletSpeed = 6 * dtFactor;

    for (const player of room.players.values()) {
      const { input } = player;
      let dx = 0;
      let dy = 0;
      if (input.w) dy -= 1;
      if (input.s) dy += 1;
      if (input.a) dx -= 1;
      if (input.d) dx += 1;
      if (dx && dy) {
        dx *= 0.7;
        dy *= 0.7;
      }

      const speedFactor = getSpeedFactor(player.y, room.mapHeight);
      const nextX = player.x + dx * speed * speedFactor * dtFactor;
      const nextY = player.y + dy * speed * speedFactor * dtFactor;

      let blocked = false;
      for (const rock of room.rocks) {
        const cx = rock.x + rock.size / 2;
        const cy = rock.y + rock.size / 2;
        const rockR = rock.size / 2;
        if (Math.hypot(nextX - cx, nextY - cy) < rockR + tankRadius) {
          blocked = true;
          break;
        }
      }

      if (!blocked) {
        player.x = Math.min(room.mapWidth, Math.max(0, nextX));
        player.y = Math.min(room.mapHeight, Math.max(0, nextY));
      }
      player.ammo = Math.min(5, player.ammo + dt / 1000);
    }

    const nextBullets = [];
    for (const bullet of room.bullets) {
      const rad = ((bullet.angle - 90) * Math.PI) / 180;
      const nx = bullet.x + Math.cos(rad) * bulletSpeed;
      const ny = bullet.y + Math.sin(rad) * bulletSpeed;

      const hitRock = room.rocks.some((r) =>
        lineIntersectsCircle(bullet.x, bullet.y, nx, ny, r.x + r.size / 2, r.y + r.size / 2, r.size / 2)
      );
      if (hitRock) continue;

      let hitPlayer = null;
      for (const [playerId, player] of room.players.entries()) {
        if (playerId === bullet.ownerId || player.health <= 0) continue;
        if (lineIntersectsCircle(bullet.x, bullet.y, nx, ny, player.x, player.y, tankRadius)) {
          hitPlayer = playerId;
          break;
        }
      }

      if (hitPlayer) {
        const target = room.players.get(hitPlayer);
        if (target) {
          target.health = Math.max(0, target.health - 1);
        }
        io.to(`${TANK_ROOM_PREFIX}${room.gameId}`).emit('tanks:hit', {
          attackerId: bullet.ownerId,
          targetId: hitPlayer,
          createdAt: now,
        });
        continue;
      }

      if (nx >= 0 && nx <= room.mapWidth && ny >= 0 && ny <= room.mapHeight) {
        nextBullets.push({ ...bullet, x: nx, y: ny });
      }
    }
    room.bullets = nextBullets;

    const players = {};
    for (const [id, player] of room.players.entries()) {
      players[id] = {
        x: player.x,
        y: player.y,
        rotation: player.rotation,
        health: player.health,
        ammo: Math.floor(player.ammo),
      };
    }

    io.to(`${TANK_ROOM_PREFIX}${room.gameId}`).emit('tanks:game_state', {
      gameId: room.gameId,
      serverTime: now,
      map: {
        width: room.mapWidth,
        height: room.mapHeight,
        rocks: room.rocks,
      },
      players,
      bullets: room.bullets.map(({ id, x, y, angle }) => ({ id, x, y, angle })),
    });
  }, TANK_TICK_MS);
}

function cleanupRoomIfEmpty(gameId) {
  const room = tanksRooms.get(gameId);
  if (!room || room.players.size > 0) return;
  if (room.interval) clearInterval(room.interval);
  tanksRooms.delete(gameId);
}

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
  socket.emit('server:hello', {
    userId: socket.data.userId,
    at: new Date().toISOString(),
  });

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

  socket.on('tanks:join_game', ({ gameId, settings }) => {
    if (!gameId) return;
    const normalizedGameId = String(gameId);
    const roomId = `${TANK_ROOM_PREFIX}${normalizedGameId}`;
    socket.join(roomId);

    if (!tanksRooms.has(normalizedGameId)) {
      tanksRooms.set(normalizedGameId, createTanksRoom(normalizedGameId, settings));
    }

    const room = tanksRooms.get(normalizedGameId);
    if (!room.players.has(socket.data.userId)) {
      const spawn = getSpawnPosition(room);
      room.players.set(socket.data.userId, {
        x: spawn.x,
        y: spawn.y,
        rotation: 0,
        health: room.maxHealth,
        ammo: 5,
        input: { w: false, a: false, s: false, d: false },
      });
    }
    ensureRoomLoop(room);
  });

  socket.on('tanks:input', ({ gameId, input, rotation }) => {
    if (!gameId) return;
    const room = tanksRooms.get(String(gameId));
    const player = room?.players.get(socket.data.userId);
    if (!player) return;

    player.input = {
      w: Boolean(input?.w),
      a: Boolean(input?.a),
      s: Boolean(input?.s),
      d: Boolean(input?.d),
    };

    if (Number.isFinite(rotation)) {
      player.rotation = Number(rotation);
    }
  });

  socket.on('tanks:shoot', ({ gameId }) => {
    if (!gameId) return;
    const room = tanksRooms.get(String(gameId));
    const player = room?.players.get(socket.data.userId);
    if (!player || player.health <= 0 || player.ammo < 1) return;

    player.ammo -= 1;
    const rad = ((player.rotation - 90) * Math.PI) / 180;
    const spawnDist = 35;
    room.bullets.push({
      id: room.nextBulletId++,
      ownerId: socket.data.userId,
      x: player.x + Math.cos(rad) * spawnDist,
      y: player.y + Math.sin(rad) * spawnDist,
      angle: player.rotation,
    });
  });

  socket.on('tanks:leave_game', ({ gameId }) => {
    if (!gameId) return;
    const normalizedGameId = String(gameId);
    const roomId = `${TANK_ROOM_PREFIX}${normalizedGameId}`;
    socket.leave(roomId);
    const room = tanksRooms.get(normalizedGameId);
    room?.players.delete(socket.data.userId);
    cleanupRoomIfEmpty(normalizedGameId);
  });

  socket.on('disconnect', () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;
      socket.to(roomId).emit('player_disconnected', { roomId, userId: socket.data.userId });
      if (roomId.startsWith(TANK_ROOM_PREFIX)) {
        const gameId = roomId.slice(TANK_ROOM_PREFIX.length);
        const room = tanksRooms.get(gameId);
        room?.players.delete(socket.data.userId);
        cleanupRoomIfEmpty(gameId);
      }
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`[realtime-server] listening on port ${PORT}`);
});
