require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const { verifyToken } = require("@clerk/backend");

const app = express();

const PORT = Number(process.env.PORT || 3001);
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;

function normalizeOrigin(origin) {
  return String(origin || "")
    .trim()
    .replace(/\/$/, "");
}

function getAllowedOrigins() {
  return String(process.env.CLIENT_URL || "")
    .split(",")
    .map((origin) => normalizeOrigin(origin))
    .filter(Boolean);
}

const allowedOrigins = getAllowedOrigins();

if (allowedOrigins.length === 0) {
  throw new Error("Missing CLIENT_URL in realtime-server/.env");
}

function isOriginAllowed(origin) {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  return allowedOrigins.includes(normalized);
}

const corsOptions = {
  origin(origin, callback) {
    if (isOriginAllowed(origin)) return callback(null, true);
    return callback(new Error("CORS origin not allowed"));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "realtime-server",
    allowedOrigins,
    clerkConfigured: Boolean(CLERK_SECRET_KEY),
    wsPath: "/socket.io",
  });
});

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin(origin, callback) {
      if (isOriginAllowed(origin)) return callback(null, true);
      return callback(new Error("Socket origin not allowed"));
    },
    methods: ["GET", "POST"],
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
    (state) =>
      Number.isFinite(Number(state?.x)) && Number.isFinite(Number(state?.y)),
  );

  for (let i = 0; i < 30; i += 1) {
    const candidate = randomSpawnPosition(room.mapWidth, room.mapHeight);
    const tooClose = occupied.some(
      (state) =>
        Math.hypot(
          Number(state.x) - candidate.x,
          Number(state.y) - candidate.y,
        ) < MIN_SPAWN_DISTANCE,
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

const TANK_ROOM_PREFIX = "match:tanks:";
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
    mode: settings.mode === "battle_royale" ? "battle_royale" : "duel",
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
        lineIntersectsCircle(
          bullet.x,
          bullet.y,
          nx,
          ny,
          r.x + r.size / 2,
          r.y + r.size / 2,
          r.size / 2,
        ),
      );
      if (hitRock) continue;

      let hitPlayer = null;
      for (const [playerId, player] of room.players.entries()) {
        if (playerId === bullet.ownerId || player.health <= 0) continue;
        if (
          lineIntersectsCircle(
            bullet.x,
            bullet.y,
            nx,
            ny,
            player.x,
            player.y,
            tankRadius,
          )
        ) {
          hitPlayer = playerId;
          break;
        }
      }

      if (hitPlayer) {
        const target = room.players.get(hitPlayer);
        if (target) {
          target.health = Math.max(0, target.health - 1);
        }
        io.to(`${TANK_ROOM_PREFIX}${room.gameId}`).emit("tanks:hit", {
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

    io.to(`${TANK_ROOM_PREFIX}${room.gameId}`).emit("tanks:game_state", {
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
      return next(new Error("Authentication token missing"));
    }

    if (!CLERK_SECRET_KEY) {
      return next(new Error("Server authentication is not configured"));
    }

    const verified = await verifyToken(token, {
      secretKey: CLERK_SECRET_KEY,
    });

    socket.data.userId = verified.sub;
    return next();
  } catch (error) {
    return next(new Error("Invalid authentication token"));
  }
});

io.on("connection", (socket) => {
  socket.emit("server:hello", {
    userId: socket.data.userId,
    at: new Date().toISOString(),
  });

  socket.on("join_room", ({ roomId }) => {
    if (!roomId) return;
    socket.join(String(roomId));
  });

  socket.on("leave_room", ({ roomId }) => {
    if (!roomId) return;
    socket.leave(String(roomId));
  });

  socket.on("room_event", ({ roomId, event, payload }) => {
    if (!roomId || !event) return;
    socket.to(String(roomId)).emit(String(event), {
      ...(payload && typeof payload === "object" ? payload : {}),
      userId: socket.data.userId,
      sentAt: new Date().toISOString(),
    });
  });

  socket.on("join_game", ({ gameId }) => {
    if (!gameId) return;
    const roomId = String(gameId);
    socket.join(roomId);
    socket
      .to(roomId)
      .emit("player_joined", { gameId: roomId, userId: socket.data.userId });
  });

  socket.on("move", ({ gameId, move }) => {
    if (!gameId || !move) return;
    const roomId = String(gameId);
    socket.to(roomId).emit("move", {
      gameId: roomId,
      move,
      userId: socket.data.userId,
      createdAt: new Date().toISOString(),
    });
  });

  socket.on("leave_game", ({ gameId }) => {
    if (!gameId) return;
    const roomId = String(gameId);
    socket.leave(roomId);
    socket
      .to(roomId)
      .emit("player_left", { gameId: roomId, userId: socket.data.userId });
  });

  socket.on("tanks:join_game", ({ gameId, settings }) => {
    if (!gameId) return;
    const normalizedGameId = String(gameId);
    const roomId = `${TANK_ROOM_PREFIX}${normalizedGameId}`;
    socket.join(roomId);

    if (!tanksRooms.has(normalizedGameId)) {
      tanksRooms.set(
        normalizedGameId,
        createTanksRoom(normalizedGameId, settings),
      );
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

  socket.on("tanks:input", ({ gameId, input, rotation }) => {
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

  socket.on("tanks:shoot", ({ gameId }) => {
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

  socket.on("tanks:leave_game", ({ gameId }) => {
    if (!gameId) return;
    const normalizedGameId = String(gameId);
    const roomId = `${TANK_ROOM_PREFIX}${normalizedGameId}`;
    socket.leave(roomId);
    const room = tanksRooms.get(normalizedGameId);
    room?.players.delete(socket.data.userId);
    cleanupRoomIfEmpty(normalizedGameId);
  });

  registerPoolSocketHandlers(socket);

  socket.on("disconnect", () => {
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;
      socket
        .to(roomId)
        .emit("player_disconnected", { roomId, userId: socket.data.userId });
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
const diceLobbies = new Map();
const diceMatches = new Map();
const roll = () => Math.floor(Math.random() * 6) + 1;
function resolveTurn(match, action) {
  const me = match.turnUserId;
  const enemy = match.player1Id === me ? match.player2Id : match.player1Id;
  let dmg = 0,
    self = 0,
    r1 = null,
    r2 = null;
  if (action === "SAFE_ROLL") {
    r1 = roll();
    dmg = r1 <= 2 ? 0 : r1 <= 4 ? 2 : 4;
  }
  if (action === "POWER_ROLL") {
    r1 = roll();
    r2 = roll();
    const t = r1 + r2;
    if (t <= 4) self = 3;
    else if (t <= 7) dmg = 3;
    else if (t <= 10) dmg = 6;
    else dmg = 8;
  }
  if (action === "SHIELD") {
    match.shields[me] = (match.shields[me] || 0) + 1;
  }
  if (dmg > 0 && (match.shields[enemy] || 0) > 0) {
    dmg = Math.floor(dmg / 2);
    match.shields[enemy] = 0;
  }
  if (match.player1Id === me) {
    match.hp2 = Math.max(0, match.hp2 - dmg);
    match.hp1 = Math.max(0, match.hp1 - self);
  } else {
    match.hp1 = Math.max(0, match.hp1 - dmg);
    match.hp2 = Math.max(0, match.hp2 - self);
  }
  match.round += 1;
  match.turnUserId = enemy;
  return { dmg, self, r1, r2 };
}

// ---- Pool Masters (input-sync, low-bandwidth) ----
const poolLobbies = new Map();
const poolMatches = new Map();
const processedShotIds = new Set();
const MATCH_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, m] of poolMatches) {
    if (
      m.status !== "active" ||
      (m.lastActivityAt && now - m.lastActivityAt > MATCH_TTL_MS)
    )
      poolMatches.delete(id);
  }
  for (const [id, l] of poolLobbies) {
    if (now - l.createdAt > 5 * 60 * 1000) poolLobbies.delete(id);
  }
}, 30000);

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, Number(v)));
}

function registerPoolSocketHandlers(socket) {
  socket.on("pool:lobbies:list", () => {
    socket.emit(
      "pool:lobbies:list",
      Array.from(poolLobbies.values()).filter((l) => l.status === "waiting"),
    );
  });

  socket.on("pool:lobby:create", (payload = {}) => {
    const lobbyId = String(
      payload.lobbyId ||
        `lobby-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    );
    if (poolLobbies.has(lobbyId)) return;
    const lobby = {
      id: lobbyId,
      hostUserId: String(payload.hostUserId),
      opponentUserId: null,
      wager: clamp(payload.wager, 1, 1000000),
      gameMode: payload.gameMode || "pvp",
      status: "waiting",
      createdAt: Date.now(),
    };
    poolLobbies.set(lobby.id, lobby);
    console.log(
      "[pool] lobby created",
      lobby.id,
      lobby.hostUserId,
      lobby.gameMode,
    );
    io.emit(
      "pool:lobbies:list",
      Array.from(poolLobbies.values()).filter((l) => l.status === "waiting"),
    );
  });

  socket.on("pool:lobby:join", ({ lobbyId, userId }) => {
    const lobby = poolLobbies.get(String(lobbyId));
    if (
      !lobby ||
      lobby.status !== "waiting" ||
      String(userId) === lobby.hostUserId ||
      lobby.opponentUserId
    )
      return;
    lobby.opponentUserId = String(userId);
    lobby.status = "active";
    const matchId = `pool-${lobby.id}`;
    const roomId = `pool:${matchId}`;
    const turn = Math.random() < 0.5 ? lobby.hostUserId : lobby.opponentUserId;
    const match = {
      id: matchId,
      lobbyId: lobby.id,
      players: [lobby.hostUserId, lobby.opponentUserId],
      turnUserId: turn,
      gameStarted: true,
      shotLock: false,
      status: "active",
      lastActivityAt: Date.now(),
      shotSeq: 0,
    };
    poolMatches.set(matchId, match);
    io.in(roomId).socketsJoin(roomId);
    io.to(roomId).emit("pool:match:start", { ...match, activePlayer: turn });
    io.to(roomId).emit("pool:turn:start", {
      matchId,
      turnUserId: turn,
      turnSeconds: 45,
    });
    console.log("[pool] match started", matchId, "turn", turn);
  });

  socket.on("pool:room:join", ({ matchId, userId }) => {
    const roomId = `pool:${String(matchId)}`;
    socket.join(roomId);
    const m = poolMatches.get(String(matchId));
    if (m) {
      socket.emit("pool:match:start", { ...m, activePlayer: m.turnUserId });
      socket.emit("pool:turn:start", {
        matchId: m.id,
        turnUserId: m.turnUserId,
        turnSeconds: 45,
      });
    }
    console.log("[pool] room join", matchId, userId);
  });

  socket.on(
    "pool:shoot",
    ({ matchId, userId, shotId, angle, power, cueBallPosition }) => {
      const m = poolMatches.get(String(matchId));
      if (!m || m.status !== "active" || m.shotLock) return;
      if (
        m.turnUserId !== String(userId) ||
        processedShotIds.has(String(shotId))
      )
        return;
      m.shotSeq += 1;
      const effectiveShotId = String(shotId || `${m.id}:${m.shotSeq}`);
      if (processedShotIds.has(effectiveShotId)) return;
      const sanitized = {
        angle: clamp(angle, 0, 360),
        power: clamp(power, 0.05, 1),
        cueBallPosition,
      };
      processedShotIds.add(effectiveShotId);
      m.shotLock = true;
      m.lastActivityAt = Date.now();
      io.to(`pool:${matchId}`).emit("pool:shoot", {
        matchId,
        userId: String(userId),
        shot: sanitized,
        shotId: effectiveShotId,
      });
      console.log("[pool] shot", matchId, userId, effectiveShotId);
    },
  );

  socket.on(
    "pool:physics:end",
    ({ matchId, shotId, nextTurnUserId, snapshot, eventSummary }) => {
      const m = poolMatches.get(String(matchId));
      if (!m || !m.shotLock || !processedShotIds.has(String(shotId))) return;
      if (nextTurnUserId && m.players.includes(String(nextTurnUserId)))
        m.turnUserId = String(nextTurnUserId);
      m.shotLock = false;
      m.lastSnapshot = snapshot;
      m.lastActivityAt = Date.now();
      io.to(`pool:${matchId}`).emit("pool:state:update", {
        matchId,
        shotId,
        snapshot,
        eventSummary,
        turnUserId: m.turnUserId,
        activePlayer: m.turnUserId,
      });
      io.to(`pool:${matchId}`).emit("pool:turn:start", {
        matchId,
        turnUserId: m.turnUserId,
        turnSeconds: 45,
      });
      console.log("[pool] turn switched", matchId, m.turnUserId);
    },
  );
}
