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
  // Explicitly set transports to support both WebSocket and long-polling.
  // Behind a reverse proxy (Render, etc.), WebSocket may fail if the
  // proxy doesn't upgrade correctly; polling serves as a reliable fallback.
  transports: ["websocket", "polling"],
  // Keep connections alive through proxies by sending pings every 25s.
  pingInterval: 25000,
  pingTimeout: 20000,
  cors: {
    origin(origin, callback) {
      if (isOriginAllowed(origin)) return callback(null, true);
      return callback(new Error("Socket origin not allowed"));
    },
    methods: ["GET", "POST"],
    credentials: true,
  },
});


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

  // ── Precision room-participant tracking ─────────────────────────
  // Required so the precision:stop handler below can reject submissions
  // from sockets that haven't actually joined the requested match
  // (mirrors the hexDuel M3 fix: stops can't be injected by sockets
  // that only joined via a generic join_room). Anchored on globalThis
  // so multiple sockets see one shared source of truth — matching the
  // existing `global.__hexDuelRoomPlayers` pattern. Keyed by matchId.
  const PRECISION_MATCH_ROOM_PREFIX = "precision:match:";
  if (!global.__precisionRoomParticipants) {
    global.__precisionRoomParticipants = new Map();
  }
  const precisionRoomParticipants = global.__precisionRoomParticipants;

  function trackPrecisionJoin(roomId, userId) {
    if (typeof roomId !== "string" || !roomId.startsWith(PRECISION_MATCH_ROOM_PREFIX)) {
      return;
    }
    const matchId = roomId.slice(PRECISION_MATCH_ROOM_PREFIX.length);
    if (!matchId) return;
    if (!precisionRoomParticipants.has(matchId)) {
      precisionRoomParticipants.set(matchId, new Set());
    }
    precisionRoomParticipants.get(matchId).add(userId);
  }
  function trackPrecisionLeave(roomId, userId) {
    if (typeof roomId !== "string" || !roomId.startsWith(PRECISION_MATCH_ROOM_PREFIX)) {
      return;
    }
    const matchId = roomId.slice(PRECISION_MATCH_ROOM_PREFIX.length);
    if (!matchId) return;
    const set = precisionRoomParticipants.get(matchId);
    if (!set) return;
    set.delete(userId);
    if (set.size === 0) precisionRoomParticipants.delete(matchId);
  }
  function forgetPrecisionUser(userId) {
    for (const [mid, set] of precisionRoomParticipants.entries()) {
      set.delete(userId);
      if (set.size === 0) precisionRoomParticipants.delete(mid);
    }
  }

  // ── Plinko PvP room-participant tracking ───────────────────────
  // Mirrors the precision tracking pattern so the plinko:ready
  // handler below can reject events from non-participant sockets.
  // Keyed by matchId (numeric).
  const PLINKO_MATCH_ROOM_PREFIX = "plinko-pvp:match:";
  if (!global.__plinkoRoomParticipants) {
    global.__plinkoRoomParticipants = new Map();
  }
  const plinkoRoomParticipants = global.__plinkoRoomParticipants;

  function trackPlinkoJoin(roomId, userId) {
    if (typeof roomId !== "string" || !roomId.startsWith(PLINKO_MATCH_ROOM_PREFIX)) {
      return;
    }
    const matchId = roomId.slice(PLINKO_MATCH_ROOM_PREFIX.length);
    if (!matchId) return;
    if (!plinkoRoomParticipants.has(matchId)) {
      plinkoRoomParticipants.set(matchId, new Set());
    }
    plinkoRoomParticipants.get(matchId).add(userId);
    console.log("[plinko-pvp] participant joined: matchId=", matchId, "userId=", userId);
  }
  function trackPlinkoLeave(roomId, userId) {
    if (typeof roomId !== "string" || !roomId.startsWith(PLINKO_MATCH_ROOM_PREFIX)) {
      return;
    }
    const matchId = roomId.slice(PLINKO_MATCH_ROOM_PREFIX.length);
    if (!matchId) return;
    const set = plinkoRoomParticipants.get(matchId);
    if (!set) return;
    set.delete(userId);
    if (set.size === 0) plinkoRoomParticipants.delete(matchId);
    console.log("[plinko-pvp] participant left: matchId=", matchId, "userId=", userId);
  }
  function forgetPlinkoUser(userId) {
    for (const [mid, set] of plinkoRoomParticipants.entries()) {
      set.delete(userId);
      if (set.size === 0) plinkoRoomParticipants.delete(mid);
    }
  }

  socket.on("join_room", ({ roomId }) => {
    if (!roomId) return;
    socket.join(String(roomId));
    trackPrecisionJoin(String(roomId), socket.data.userId);
    trackPlinkoJoin(String(roomId), socket.data.userId);
  });

  socket.on("leave_room", ({ roomId }) => {
    if (!roomId) return;
    socket.leave(String(roomId));
    trackPrecisionLeave(String(roomId), socket.data.userId);
    trackPlinkoLeave(String(roomId), socket.data.userId);
  });

  socket.on("room_event", ({ roomId, event, payload }) => {
    if (!roomId || !event) return;
    socket.to(String(roomId)).emit(String(event), {
      ...(payload && typeof payload === "object" ? payload : {}),
      userId: socket.data.userId,
      sentAt: new Date().toISOString(),
    });
  });

  // ── Deprecated join_game handler — replaced by hexDuel:join ──
  // Keeping as a no-op stub so old clients don't break, but no longer
  // adds duplicate tracking. The hexDuel:join handler below is the
  // single source of truth for hex duel room joins.
  socket.on("join_game", ({ gameId }) => {
    if (!gameId) return;
    console.warn("[deprecated] join_game received for gameId", gameId, "— use hexDuel:join instead");
    // No-op: hexDuel:join handles all game room logic.
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

    // Clean up module-level tracking
    const players = hexDuelRoomPlayers.get(String(gameId));
    if (players) {
      players.delete(socket.data.userId);
      if (players.size === 0) hexDuelRoomPlayers.delete(String(gameId));
    }

    socket
      .to(roomId)
      .emit("player_left", { gameId: roomId, userId: socket.data.userId });
  });


  registerPoolSocketHandlers(socket);

  // ── Hex Duel ────────────────────────────────────────────────────
  // Lightweight in-memory turn tracking for Hex Duel multiplayer games
  const hexDuelTurnStates = new Map();
  // Track which gameIds each socket has joined (so we can emit disconnect events)
  const hexDuelGameIds = new Set();

  // Module-level tracking: which userIds are present in each game room
  if (!global.__hexDuelRoomPlayers) global.__hexDuelRoomPlayers = new Map();
  const hexDuelRoomPlayers = global.__hexDuelRoomPlayers;

  function checkAndEmitHexDuelReady(gameId, roomId) {
    const players = hexDuelRoomPlayers.get(String(gameId));
    if (!players || players.size < 2) {
      // Also verify via socket.io rooms as fallback
      const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
      if (!socketsInRoom || socketsInRoom.size < 2) return;
    }
    io.to(roomId).emit("hexDuel:opponent:ready", {
      gameId: roomId,
      joinedAt: new Date().toISOString(),
    });
  }

  socket.on("hexDuel:action", ({ gameId, action }) => {
    if (!gameId || !action) return;
    const roomId = String(gameId);
    const userId = socket.data.userId;

    // Audit M3 fix: only relay actions from sockets that have been
    // tracked as a player in this game's room. Without this, any socket
    // that joined the room via join_room could inject adversarial
    // hexDuel:action events to the opponent.
    const players = hexDuelRoomPlayers.get(String(gameId));
    if (!players || !players.has(userId)) {
      console.warn(
        "[hex-duel] rejecting action from non-participant: room=",
        roomId,
        "userId=",
        userId,
        "playerCount=",
        players ? players.size : 0,
        "action=",
        action.type,
      );
      return;
    }

    // Always relay to the room — if the opponent is temporarily disconnected,
    // they will catch up via action polling. The old room-size check caused
    // actions to be silently dropped during brief reconnect windows.
    const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
    const roomSize = socketsInRoom?.size ?? 0;

    // Track the action with a sequence counter to prevent accidental
    // double-processing from network retries, while still allowing
    // identical consecutive actions (e.g. same attack twice in a row).
    if (!global.__hexDuelActionSeq) global.__hexDuelActionSeq = new Map();
    const seqMap = global.__hexDuelActionSeq;
    const seqKey = `${gameId}:${userId}`;
    const prevSeq = seqMap.get(seqKey) ?? -1;
    const thisSeq = action.__seq ?? Date.now();
    if (!action.__seq) action.__seq = thisSeq;
    // Only dedupe if the exact same sequence arrives (network retry)
    if (thisSeq === prevSeq) {
      console.warn(
        "[hex-duel] dedup-drop (same seq as previous):",
        roomId,
        "userId=",
        userId,
        "seq=",
        thisSeq,
        "action=",
        action.type,
      );
      return;
    }
    seqMap.set(seqKey, thisSeq);

    // Clean old entries after 5 minutes
    const now = Date.now();
    for (const [k, t] of hexDuelTurnStates) {
      if (now - t > 300000) hexDuelTurnStates.delete(k);
    }

    // Relay action to the other player. Audit trail helps debug cases
    // where the receiver reports actions never arrived.
    console.log(
      "[hex-duel] relay:",
      roomId,
      "from=",
      userId,
      "type=",
      action.type,
      "player=",
      action.player,
      "seq=",
      thisSeq,
      "roomSize=",
      roomSize,
    );
    socket.to(roomId).emit("hexDuel:action", {
      gameId: roomId,
      action,
      userId,
      createdAt: new Date().toISOString(),
    });
  });

  // When a player joins a hex duel game room, notify the other player
  socket.on("hexDuel:join", ({ gameId }) => {
    if (!gameId) return;
    const roomId = String(gameId);
    socket.join(roomId);
    hexDuelGameIds.add(gameId);

    // Track player in module-level map
    if (!hexDuelRoomPlayers.has(String(gameId))) {
      hexDuelRoomPlayers.set(String(gameId), new Set());
    }
    hexDuelRoomPlayers.get(String(gameId)).add(socket.data.userId);

    checkAndEmitHexDuelReady(gameId, roomId);
  });

  socket.on("hexDuel:resign", ({ gameId }) => {
    if (!gameId) return;
    const roomId = String(gameId);
    socket.to(roomId).emit("hexDuel:opponent:resigned", {
      gameId: roomId,
      userId: socket.data.userId,
      resignedAt: new Date().toISOString(),
    });
  });

  // Relay clock expiry to the opponent
  socket.on("hexDuel:clockExpired", ({ gameId }) => {
    if (!gameId) return;
    const roomId = String(gameId);
    socket.to(roomId).emit("hexDuel:opponent:timeout", {
      gameId: roomId,
      userId: socket.data.userId,
      expiredAt: new Date().toISOString(),
    });
  });

  // State sync: one player requests full state from the other
  socket.on("hexDuel:requestSync", ({ gameId }) => {
    if (!gameId) return;
    const roomId = String(gameId);
    socket.to(roomId).emit("hexDuel:requestSync", {
      gameId: roomId,
      userId: socket.data.userId,
      requestedAt: new Date().toISOString(),
    });
  });

  // State sync: relay the full state snapshot to the requesting player
  socket.on("hexDuel:syncState", ({ gameId, snapshot }) => {
    if (!gameId || !snapshot) return;
    const roomId = String(gameId);
    socket.to(roomId).emit("hexDuel:syncState", {
      gameId: roomId,
      snapshot,
      userId: socket.data.userId,
      sentAt: new Date().toISOString(),
    });
  });

  // ── Precision: stop ─────────────────────────────────────────────
  // The client emits `precision:stop` exactly once per round when the
  // user presses STOP. We validate that the calling socket is a
  // participant of the requested precision match (tracked above) and
  // that the stopMs falls in the server-allowed range, then proxy the
  // stopMs to the Next.js `/api/precision/round-stop` route via HTTP.
  // That route calls the canonical `recordRoundStop` in
  // `src/lib/precision/serverStore.ts`, which is the only code path
  // that computes the round winner — the realtime server does NO
  // winner computation, matching the codebase's "never trust the
  // client" and "do not determine the winner on the client" invariants.
  //
  // Response is delivered via the Socket.IO ACK callback: `{ success,
  // error? }`. The match state is rebroadcast back to ALL sockets in
  // the match room (including the sender) ONLY once BOTH seats have
  // submitted (`bothStopped === true`) — partial stops keep the
  // sender's optimistic "stopped, awaiting opponent" UI intact.
  socket.on("precision:stop", async ({ matchId, roundId, nonce } = {}, ack) => {
    const matchIdStr = String(matchId || "");
    if (!matchIdStr) {
      if (typeof ack === "function") ack({ success: false, error: "Missing matchId." });
      return;
    }
    const roundIdStr = String(roundId || "");
    const nonceStr = String(nonce || "");
    if (!roundIdStr) {
      if (typeof ack === "function") ack({ success: false, error: "Missing roundId." });
      return;
    }
    if (!nonceStr) {
      if (typeof ack === "function") ack({ success: false, error: "Missing nonce." });
      return;
    }
    // Participation check — reject submissions from sockets that
    // didn't actually join the requested match room. This handler
    // is intentionally dumb about timing: the server-authoritative
    // STOP instant is stamped inside the Next.js route's
    // `recordRoundStop`, and elapsed time is computed there from
    // `match.roundGoInstant`. We forward ONLY the bare STOP signal
    // PLUS the round-replay envelope (roundId, nonce) so the
    // canonical recordRoundStop function can validate and reject
    // stale packets without trusting the realtime layer's
    // intermediate state.
    const participants = precisionRoomParticipants.get(matchIdStr);
    if (!participants || !participants.has(socket.data.userId)) {
      if (typeof ack === "function") {
        ack({ success: false, error: "Caller is not a participant in this match." });
      }
      return;
    }
    try {
      const baseUrl = process.env.NEXTJS_INTERNAL_URL || "http://localhost:3000";
      // ── CRITICAL fix: AbortController timeout on the Next.js proxy
      // ── Without this, if Next.js hangs or drops the connection, the
      // ── Promise never resolves, the `ack(...)` callback is never
      // ── fired, and the client's STOP button stays permanently
      // ── disabled (locked by `stopSubmitting = true`). The same
      // ── pattern mirrors the existing pool/dice/farkle realtime
      // ── proxies in this file.
      const forwardController = new AbortController();
      const forwardTimeout = setTimeout(
        () => forwardController.abort(),
        4000,
      );
      const res = await fetch(
        `${baseUrl}/api/precision/round-stop`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            matchId: matchIdStr,
            userId: socket.data.userId,
            roundId: roundIdStr,
            nonce: nonceStr,
          }),
          signal: forwardController.signal,
        },
      );
      clearTimeout(forwardTimeout);
      const payload = await res.json().catch(() => null);
      if (!payload || !payload.success) {
        if (typeof ack === "function") {
          ack({
            success: false,
            error: (payload && payload.error) || "Server rejected the stop.",
          });
        }
        return;
      }
      // Acknowledge the caller FIRST so they can flip their
      // `stopSubmitting` spinner off even before the broadcast is
      // delivered (the broadcast fans out below; the ACK is direct).
      if (typeof ack === "function") ack({ success: true });
      // Only rebroadcast the updated match state to the room once
      // BOTH seats have submitted — partial stops (one seat only)
      // keep the sender's "✓ STOP SENT" UI intact and let the
      // opponent's timer keep running until they also submit.
      const roomId = `${PRECISION_MATCH_ROOM_PREFIX}${matchIdStr}`;
      if (payload.bothStopped) {
        io.to(roomId).emit("precision:roundResult", {
          matchId: matchIdStr,
          match: payload.match,
          bothStopped: true,
          roundWinnerSeat: payload.roundWinnerSeat ?? null,
          matchFinished: payload.matchFinished === true,
        });
        if (payload.matchFinished) {
          io.to(roomId).emit("precision:matchFinished", {
            matchId: matchIdStr,
            match: payload.match,
          });
        } else {
          // Round decided but match continues — server-side
          // armMatchRound will fire after a random delay; emit
          // roundArmStart so the opponent flips to the "Get ready…"
          // screen without waiting for the 1.5s poll.
          io.to(roomId).emit("precision:roundArmStart", {
            matchId: matchIdStr,
            match: payload.match,
          });
        }
      }
    } catch (err) {
      // Internal fetch failure (Next.js down, network blip, or the
      // AbortController above fired). Surface to the caller so they
      // can unlock the optimistic STOP button. Map `AbortError` to
      // a friendlier message so the player understands the network
      // didn't deliver in time.
      if (typeof ack === "function") {
        const isAbort = err && (err.name === "AbortError" || /aborted/i.test(String(err.message)));
        ack({
          success: false,
          error: isAbort
            ? "Stop timed out before the server confirmed. Please try again."
            : ((err && err.message) || "Realtime proxy unreachable."),
        });
      }
    }
  });

  // ── Plinko PvP: ready ──────────────────────────────────────────
  // The client emits `plinko:ready` after a successful /launch POST
  // so the opponent gets an instant "refresh" push instead of
  // waiting for the 800ms HTTP poll. The handler validates that the
  // caller is a tracked participant, then broadcasts `lobby:updated`
  // to the match room (excluding the sender).
  //
  // This replaces the previous `room_event` emit pattern (which
  // still works as a fallback) with a dedicated handler that logs
  // events for audit/debugging and enforces participation checks.
  socket.on("plinko:ready", ({ matchId } = {}) => {
    if (!matchId) return;
    const matchIdStr = String(matchId);
    // Belt-and-suspenders: only allow numeric match IDs to prevent
    // path-traversal-like room constructions from buggy/malicious
    // clients.
    if (!/^\d+$/.test(matchIdStr)) {
      console.warn(
        "[plinko-pvp] rejecting plinko:ready with non-numeric matchId:",
        matchIdStr,
        "userId=",
        socket.data.userId,
      );
      return;
    }
    const participants = plinkoRoomParticipants.get(matchIdStr);
    if (!participants || !participants.has(socket.data.userId)) {
      console.warn(
        "[plinko-pvp] rejecting plinko:ready from non-participant: matchId=",
        matchIdStr,
        "userId=",
        socket.data.userId,
        "participantCount=",
        participants ? participants.size : 0,
      );
      return;
    }
    const roomId = `${PLINKO_MATCH_ROOM_PREFIX}${matchIdStr}`;
    const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
    const roomSize = socketsInRoom?.size ?? 0;
    console.log(
      "[plinko-pvp] relay ready: matchId=",
      matchIdStr,
      "from=",
      socket.data.userId,
      "roomSize=",
      roomSize,
    );
    socket.to(roomId).emit("lobby:updated", {
      matchId: matchIdStr,
      userId: socket.data.userId,
      sentAt: new Date().toISOString(),
    });
  });

  // ── Keep existing disconnect handler ──
  socket.on("disconnect", () => {
    // For Precision: drop user from all precision match rooms they
    // had joined so the next reconnect starts a clean participant set.
    forgetPrecisionUser(socket.data.userId);

    // For Plinko PvP: drop user from all plinko match rooms
    forgetPlinkoUser(socket.data.userId);

    // For hex duel: emit a dedicated disconnect event so the opponent gets a win
    if (hexDuelGameIds.size > 0) {
      for (const gid of hexDuelGameIds) {
        const roomId = String(gid);
        // Clean up module-level tracking
        const players = hexDuelRoomPlayers.get(String(gid));
        if (players) {
          players.delete(socket.data.userId);
          if (players.size === 0) hexDuelRoomPlayers.delete(String(gid));
        }
        // Check the room still has players
        io.to(roomId).emit("hexDuel:opponent:disconnected", {
          gameId: roomId,
          userId: socket.data.userId,
        });
      }
    }

    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;
      socket
        .to(roomId)
        .emit("player_disconnected", { roomId, userId: socket.data.userId });

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
