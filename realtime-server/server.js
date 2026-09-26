require("dotenv").config();

const crypto = require("node:crypto");
const http = require("http");
const express = require("express");
const helmet = require("helmet");
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

app.use(helmet());
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

// ── Server-to-server emit ──────────────────────────────────────────────
// Lets the Next.js backend push events to socket rooms (e.g. admin
// notifications when a player report / contact message is inserted). The
// Next.js side calls this via src/lib/adminNotify.ts. The endpoint is
// authenticated with REALTIME_INTERNAL_SECRET (same secret as the
// crash-arena sweep): it FAILS CLOSED — a missing/invalid secret returns
// 401, so /emit is never exposed unauthenticated.
app.post("/emit", (req, res) => {
  const secret = process.env.REALTIME_INTERNAL_SECRET;
  if (!secret) {
    return res.status(503).json({
      success: false,
      error: "REALTIME_INTERNAL_SECRET is not configured",
    });
  }
  const inputSecret = req.headers["x-internal-secret"];
  if (!inputSecret || !crypto.timingSafeEqual(
    crypto.createHash('sha256').update(inputSecret).digest(),
    crypto.createHash('sha256').update(secret).digest()
  )) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  const { room, event, payload } = req.body || {};
  if (!room || !event) {
    return res.status(400).json({ success: false, error: "room and event are required" });
  }
  const roomName = String(room);
  const eventName = String(event);
  // Lifecycle events are scoped to canonical match rooms. The endpoint is
  // internal-only by the shared secret above, and payloads are forwarded
  // without granting clients any authority over game state.
  if (eventName === "match:lifecycle" && !roomName.startsWith("match:lifecycle:")) {
    return res.status(400).json({ success: false, error: "Invalid lifecycle room" });
  }
  io.to(roomName).emit(eventName, {
    ...(payload && typeof payload === "object" ? payload : {}),
    sentAt: new Date().toISOString(),
  });
  res.json({ success: true });
});

// Room that verified admins join to receive admin notifications (new
// player reports / contact messages). Joining is gated by the `admin:join`
// handler below, which re-verifies admin status server-side via Next.js —
// a plain `join_room` with this id is never honored.
const ADMIN_NOTIFICATIONS_ROOM = "admin:notifications";

// H4: rate-limited logger for hot realtime paths. Logging every socket
// event (pool shot, hex action, participant join/leave, relay) floods
// stdout and burns CPU on the single realtime instance. `logThrottled`
// emits at most one line per key per LOG_WINDOW_MS while still logging the
// first event in each window (keeps live-connection visibility). Set
// REALTIME_DEBUG=1 to log everything. Pure logging — no gameplay effect.
const LOG_WINDOW_MS = 30000;
const _logThrottle = new Map();
function logThrottled(key, ...args) {
  const now = Date.now();
  const last = _logThrottle.get(key) || 0;
  if (process.env.REALTIME_DEBUG === "1" || now - last >= LOG_WINDOW_MS) {
    _logThrottle.set(key, now);
    console.log(...args);
  }
}

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  // Explicitly set transports to support both WebSocket and long-polling.
  // Behind a reverse proxy (Render, etc.), WebSocket may fail if the
  // proxy doesn't upgrade correctly; polling serves as a reliable fallback.
  transports: ["websocket", "polling"],
  // Keep connections alive through proxies by sending pings every 25s.
  pingInterval: 25000,
  pingTimeout: 20000,
  // Compress match/lobby state payloads over the wire (negotiated
  // automatically with the client). Shrinks every realtime frame, which
  // matters most when broadcasting large authoritative snapshots (tower
  // state, player tables) to 2-6 participants at once.
  perMessageDeflate: true,
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
    // Keep the raw session token so background jobs (e.g. the Crash
    // Arena disconnect cleanup) can re-verify the user server-side
    // without trusting any client-supplied identity.
    socket.data.clerkToken = token;
    return next();
  } catch (error) {
    return next(new Error("Invalid authentication token"));
  }
});

// ── Crash Arena disconnect grace timer ────────────────────────────────
// When a socket belonging to a crash-arena participant drops (tab
// closed, network blip, page refresh) the player's seat is kept for a
// short grace window so a quick refresh / socket reconnect does NOT
// kick them out of the table. If they don't come back within the
// window, the seat + table balance are released via the Next.js
// `/api/crash-arena/disconnect-cleanup` route (same net effect as
// "Back to Lobby"). Re-joining the room (join_room) cancels the timer.
// Anchored on globalThis so every socket/connection shares one map.
//
// The SAME grace-window idea is generalized below for the 1v1 games
// (hex duel / precision / plinko): a confirmed disconnect resolves the
// match in the opponent's favor, but only after the grace window, so a
// quick refresh / reconnect is never a loss. Re-joining cancels the
// timer; on expiry each game either emits its disconnect event or
// calls an internal forfeit route.
const CRASH_ARENA_MATCH_ROOM_PREFIX = "crash-arena:match:";
if (!global.__crashArenaDisconnectTimers) {
  global.__crashArenaDisconnectTimers = new Map();
}
const crashArenaDisconnectTimers = global.__crashArenaDisconnectTimers;

// Grace period before an absent player's seat is released. Covers a
// page refresh (a few seconds) AND Socket.IO's auto-reconnect backoff
// (up to ~40s with the client's 10 attempts / exponential delay).
const CRASH_ARENA_DISCONNECT_GRACE_MS = 45_000;
// Deferred cleanups (player cashed out mid-round and could still win
// the pot) are re-checked on this cadence until the round settles.
const CRASH_ARENA_DISCONNECT_RETRY_MS = 15_000;
const CRASH_ARENA_DISCONNECT_MAX_ATTEMPTS = 12; // ~3 min of retries

function crashArenaDisconnectKey(userId, tableId) {
  return `${userId}:${tableId}`;
}

function cancelCrashArenaDisconnectTimer(userId, tableId) {
  const key = crashArenaDisconnectKey(userId, tableId);
  const handle = crashArenaDisconnectTimers.get(key);
  if (handle) {
    clearTimeout(handle.timer);
    crashArenaDisconnectTimers.delete(key);
  }
}

/**
 * True when another live socket belonging to the same user is still
 * connected to the given room — i.e. the user has a second tab open.
 */
function hasLiveSocketForUser(userId, roomId) {
  const roomSockets = io.sockets.adapter.rooms.get(roomId);
  if (!roomSockets || roomSockets.size === 0) return false;
  for (const sid of roomSockets) {
    const s = io.sockets.sockets.get(sid);
    if (s && s.data && s.data.userId === userId) return true;
  }
  return false;
}

function scheduleCrashArenaDisconnectCleanup(userId, clerkToken, tableId, attempt = 0) {
  const key = crashArenaDisconnectKey(userId, tableId);
  cancelCrashArenaDisconnectTimer(userId, tableId); // replace any existing timer
  const delay = attempt === 0 ? CRASH_ARENA_DISCONNECT_GRACE_MS : CRASH_ARENA_DISCONNECT_RETRY_MS;
  const timer = setTimeout(async () => {
    crashArenaDisconnectTimers.delete(key);

    // Belt-and-suspenders: if the user's socket came back before this
    // fired (and re-joining somehow missed the cancel), don't clean up.
    const roomId = `${CRASH_ARENA_MATCH_ROOM_PREFIX}${tableId}`;
    if (hasLiveSocketForUser(userId, roomId)) return;

    // NOTE: only reached when the user is genuinely still away.


    try {
      const baseUrl = process.env.NEXTJS_INTERNAL_URL || "http://localhost:3000";
      const res = await fetch(`${baseUrl}/api/crash-arena/disconnect-cleanup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tableId, token: clerkToken }),
      });
      const payload = await res.json().catch(() => null);
      const ok = payload && payload.success === true;
      if (ok) {
        // Push an instant refresh so the remaining players + lobby drop
        // the released seat without waiting for the 5s poll.
        io.to(roomId).emit("lobby:updated", {
          tableId,
          left: true,
          userId,
          disconnected: true,
        });
        io.to("lobby:crash-arena").emit("lobby:updated", {
          tableId,
          left: true,
          userId,
          disconnected: true,
        });
      }
      // Re-check when the cleanup was deferred (player has an unresolved
      // win in a running round — it will settle and pay them first) or
      // failed transiently (Next.js briefly unreachable / rate limit).
      // Bounded so a genuinely failing cleanup can't spin forever.
      const shouldRetry = !ok || (payload && payload.deferred === true);
      if (shouldRetry && attempt + 1 < CRASH_ARENA_DISCONNECT_MAX_ATTEMPTS) {
        scheduleCrashArenaDisconnectCleanup(userId, clerkToken, tableId, attempt + 1);
      }
    } catch (err) {
      console.warn(
        "[crash-arena] disconnect cleanup failed:",
        err && err.message ? err.message : err,
      );
    }
  }, delay);
  crashArenaDisconnectTimers.set(key, { timer });
}

// ── Crash Arena stale-seat sweep ──────────────────────────────────────
// Belt-and-suspenders safety net for crash_arena_players rows whose
// socket vanished without the per-socket disconnect timer catching it
// (realtime server restart, missed disconnect event, process crash).
// Every tick it asks Next.js for all seated/waiting rows, compares them
// against LIVE sockets in each table room, and releases any row whose
// user has been absent for at least the grace window.
//
// Why observe absence across ticks instead of releasing immediately?
// A page refresh / socket reconnect is a few seconds of absence — the
// per-socket timer already waits the full 45s grace for exactly that.
// Tracking "first observed absent" across two 30s ticks gives the same
// ~45-60s window, so a quick reconnect is never treated as a stale seat.
// Idempotent: releasing an already-released row is a no-op.
//
// NOTE: presence is derived from THIS instance's sockets, so the sweep
// (like the per-socket timers below) assumes a single realtime-server
// instance — the same assumption the rest of this file already makes.
const CRASH_ARENA_SWEEP_INTERVAL_MS = 30_000;
const CRASH_ARENA_SWEEP_GRACE_MS = 45_000;
if (!global.__crashArenaSweepAbsence) {
  global.__crashArenaSweepAbsence = new Map();
}
const crashArenaSweepAbsence = global.__crashArenaSweepAbsence;

function crashArenaSweepKey(tableId, userId) {
  return `${tableId}:${userId}`;
}

/**
 * Live-socket presence per crash arena table, derived straight from the
 * Socket.IO adapter (ground truth — repopulates automatically as clients
 * reconnect and re-emit join_room, unlike in-memory participant maps).
 * @returns {Map<string, Set<string>>} tableId (string) → Set of clerkIds
 */
function crashArenaSweepPresence() {
  const present = new Map();
  const rooms = io.sockets.adapter.rooms;
  if (!rooms || typeof rooms.entries !== "function") return present;
  for (const [roomId, socketIds] of rooms.entries()) {
    if (typeof roomId !== "string" || !roomId.startsWith(CRASH_ARENA_MATCH_ROOM_PREFIX)) {
      continue;
    }
    const tableId = roomId.slice(CRASH_ARENA_MATCH_ROOM_PREFIX.length);
    for (const sid of socketIds) {
      const s = io.sockets.sockets.get(sid);
      if (s && s.data && s.data.userId) {
        if (!present.has(tableId)) present.set(tableId, new Set());
        present.get(tableId).add(s.data.userId);
      }
    }
  }
  return present;
}

function crashArenaSweepHeaders() {
  const headers = { "Content-Type": "application/json" };
  // Optional shared secret — set REALTIME_INTERNAL_SECRET on BOTH the
  // realtime server and Next.js to lock the sweep down in production.
  if (process.env.REALTIME_INTERNAL_SECRET) {
    headers["x-internal-secret"] = process.env.REALTIME_INTERNAL_SECRET;
  }
  return headers;
}

async function runCrashArenaStaleSweep() {
  try {
    const baseUrl = process.env.NEXTJS_INTERNAL_URL || "http://localhost:3000";

    // C6 gate: if no crash-arena match room has ANY live socket, there is
    // nothing to sweep, so skip the Next.js list/release round-trip entirely
    // (this was a fixed DB round-trip every 30s regardless of activity).
    // Live presence derives from THIS instance's sockets (the same
    // single-server assumption the sweep already makes), so an empty
    // adapter scan is the correct all-clear signal.
    let hasLiveCrashArenaSockets = false;
    const adapterRooms = io.sockets.adapter.rooms;
    if (adapterRooms && typeof adapterRooms.entries === "function") {
      for (const [roomId] of adapterRooms.entries()) {
        if (
          typeof roomId === "string" &&
          roomId.startsWith(CRASH_ARENA_MATCH_ROOM_PREFIX)
        ) {
          hasLiveCrashArenaSockets = true;
          break;
        }
      }
    }
    if (!hasLiveCrashArenaSockets) {
      crashArenaSweepAbsence.clear();
      return;
    }

    // 1. Candidate rows currently seated / waiting (tableId + clerkId).
    const listRes = await fetch(`${baseUrl}/api/crash-arena/sweep-stale`, {
      method: "POST",
      headers: crashArenaSweepHeaders(),
      body: JSON.stringify({ action: "list" }),
    });
    const listData = await listRes.json().catch(() => null);
    if (!listData || listData.success !== true || !Array.isArray(listData.data?.rows)) {
      return;
    }
    const rows = listData.data.rows.filter(
      (r) => Number.isFinite(Number(r?.tableId)) && typeof r?.userId === "string",
    );
    if (rows.length === 0) {
      crashArenaSweepAbsence.clear();
      return;
    }

    // 2. Compare against live sockets; track how long each absent row has
    //    been gone. Release only rows absent for ≥ the grace window.
    const present = crashArenaSweepPresence();
    const now = Date.now();
    const release = [];
    const validKeys = new Set();

    for (const row of rows) {
      const key = crashArenaSweepKey(row.tableId, row.userId);
      validKeys.add(key);
      const isPresent = (present.get(String(row.tableId)) || new Set()).has(row.userId);
      if (isPresent) {
        crashArenaSweepAbsence.delete(key);
        continue;
      }
      const absentSince = crashArenaSweepAbsence.get(key);
      if (absentSince != null && now - absentSince >= CRASH_ARENA_SWEEP_GRACE_MS) {
        release.push({ tableId: Number(row.tableId), userId: row.userId });
        crashArenaSweepAbsence.delete(key);
      } else {
        crashArenaSweepAbsence.set(key, absentSince ?? now);
      }
    }

    // Drop absence records for rows that no longer exist (already
    // released by the per-socket timer or a manual leave).
    for (const key of crashArenaSweepAbsence.keys()) {
      if (!validKeys.has(key)) crashArenaSweepAbsence.delete(key);
    }

    if (release.length === 0) return;

    // 2b. Re-check live presence for the exact release list right before
    //     sending it — a player could have reconnected (refresh, tab
    //     re-opened) during the list→release round trip, and kicking them
    //     the instant they return would defeat the whole grace design.
    const presentNow = crashArenaSweepPresence();
    const stillStale = release.filter(
      (r) => !(presentNow.get(String(r.tableId)) || new Set()).has(r.userId),
    );
    if (stillStale.length === 0) return;

    // 3. Ask Next.js to release the confirmed-stale seats.
    const relRes = await fetch(`${baseUrl}/api/crash-arena/sweep-stale`, {
      method: "POST",
      headers: crashArenaSweepHeaders(),
      body: JSON.stringify({ action: "release", release: stillStale }),
    });
    const relData = await relRes.json().catch(() => null);
    if (!relData || relData.success !== true) {
      console.warn("[crash-arena] stale sweep release rejected:", relRes.status);
      return;
    }

    // 4. Push an instant refresh so live clients + the lobby drop the
    //    released seats without waiting for the 5s poll.
    const released = Array.isArray(relData.data?.released) ? relData.data.released : [];
    for (const r of released) {
      io.to(`${CRASH_ARENA_MATCH_ROOM_PREFIX}${r.tableId}`).emit("lobby:updated", {
        tableId: r.tableId,
        left: true,
        userId: r.userId,
        disconnected: true,
        swept: true,
      });
      io.to("lobby:crash-arena").emit("lobby:updated", {
        tableId: r.tableId,
        left: true,
        userId: r.userId,
        disconnected: true,
        swept: true,
      });
    }
    if (released.length > 0) {
      console.log(
        "[crash-arena] stale sweep released",
        released.length,
        "seat(s)",
        released.map((r) => `${r.tableId}:${r.userId}`).join(","),
      );
    }
  } catch (err) {
    console.warn(
      "[crash-arena] stale sweep failed:",
      err && err.message ? err.message : err,
    );
  }
}

// Start the periodic sweep (first tick after one interval).
setInterval(runCrashArenaStaleSweep, CRASH_ARENA_SWEEP_INTERVAL_MS);

// ── Adaptive sweep cadence ────────────────────────────────────────────
// The crash sweep is the game clock for every running Crash Poker hand, so
// it must tick at 1s while any hand is live. But when nothing is running it
// previously hit Next.js (and Postgres) every second around the clock —
// ~86k idle round-trips/day. `crashArenaRunningHands` is an in-process
// hint for live hands: it is bumped the moment a `crashArena:updated`
// roundStarted relay is seen (so the 1s clock resumes instantly on a real
// start) and reconciled to ground truth — the sweep's authoritative
// scanned count — on every crash sweep, so drift is bounded to one tick.
// While the hint is 0, both sweeps back off to their idle liveness polls.
let crashArenaRunningHands = 0;
// Last time a roundStarted relay was seen — absorbs the commit→emit→scan
// race so a scan racing a fresh start can't wrongly idle the game clock.
let crashArenaLastStartSeenAt = 0;
const CRASH_ARENA_START_SETTLE_MS = 5_000;

let crashArenaCrashSweepTimer = null;

function scheduleCrashArenaCrashSweep(overrideDelayMs) {
  if (crashArenaCrashSweepTimer) clearTimeout(crashArenaCrashSweepTimer);
  crashArenaCrashSweepTimer = setTimeout(
    runCrashArenaCrashSweep,
    overrideDelayMs != null
      ? overrideDelayMs
      : crashArenaRunningHands > 0
        ? CRASH_ARENA_CRASH_SWEEP_INTERVAL_MS
        : CRASH_ARENA_CRASH_SWEEP_IDLE_INTERVAL_MS,
  );
}

// ── Crash Arena crash sweep ───────────────────────────────────────────
// The crash point is generated server-side at hand start and NEVER sent to
// clients before the crash. Because the curve is deterministic
// (multiplier = e^(GROWTH_RATE·t)), the exact moment the curve crosses the
// crash point is a server-side constant: the Next.js crash-check route
// settles every running hand whose crash time has passed and returns the
// settled hands. This sweep then broadcasts the crash (with the now-
// revealed multiplier + authoritative results) to the table room, so every
// client animates the same explosion at the same multiplier — decided by
// server time, never by a client timer or network latency.
//
// Same internal-route pattern as the auto-fold sweep. Runs unconditionally
// (unlike the un-stall/stale sweeps): a due hand must settle even when no
// socket is connected, so carry-over + table status stay correct for the
// next hand.
const CRASH_ARENA_CRASH_SWEEP_INTERVAL_MS = 1000;
// Idle liveness cadence: while no hand is running the sweep backs off from
// 1s to 15s. A `crashArena:updated` roundStarted relay snaps it back to 1s
// the moment a new hand starts; the idle tick also discovers hands that
// started without a socket relay (broken-socket host) within 15s. Cuts
// ~86k idle round-trips/day down to ~5.7k.
const CRASH_ARENA_CRASH_SWEEP_IDLE_INTERVAL_MS = 15_000;

async function runCrashArenaCrashSweep() {
  try {
    const baseUrl = process.env.NEXTJS_INTERNAL_URL || "http://localhost:3000";

    const res = await fetch(`${baseUrl}/api/crash-arena/crash-check`, {
      method: "POST",
      headers: crashArenaSweepHeaders(),
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => null);
    if (!data || data.success !== true) {
      if (res.status >= 500) {
        console.warn("[crash-arena] crash sweep rejected:", res.status);
      }
      return;
    }

    const crashed = Array.isArray(data.data?.crashed) ? data.data.crashed : [];
    for (const evt of crashed) {
      if (evt == null || evt.tableId == null) continue;
      const roomId = `${CRASH_ARENA_MATCH_ROOM_PREFIX}${evt.tableId}`;
      // Folds-out (kind "fold-out") carry NO crash multiplier — the hand
      // ended by fold-out, not by crashing, so the realtime payload omits
      // `crashed`/`multiplier` and just hands over the results.
      const isFoldOut = evt.kind === "fold-out";
      io.to(roomId).emit("lobby:updated", {
        tableId: evt.tableId,
        // The settled round's id travels with the results so a client whose
        // local "current round" pointer was never set (joined late, missed
        // the round-start relay) still applies the settlement instead of
        // silently dropping it — which left the table frozen on the fold-out
        // "settling payouts" card.
        roundId: evt.roundId,
        ...(isFoldOut
          ? { handOver: true, results: evt.results || null }
          : {
              crashed: true,
              multiplier: evt.multiplier,
              handOver: true,
              results: evt.results || null,
            }),
        sentAt: new Date().toISOString(),
      });
      // Keep the lobby grid's LIVE badge in sync too.
      io.to("lobby:crash-arena").emit("lobby:updated", {
        tableId: evt.tableId,
        crashed: true,
        roundId: evt.roundId,
        sentAt: new Date().toISOString(),
      });
    }
    if (crashed.length > 0) {
      console.log(
        "[crash-arena] crash sweep settled",
        crashed.length,
        "hand(s)",
        crashed
          .map((e) =>
            e.multiplier == null
              ? `#${e.roundId} (fold-out)`
              : `#${e.roundId}@${e.multiplier}x`,
          )
          .join(","),
      );
    }
    // ── Reconcile the running-hand hint against ground truth ───────────
    // The sweep is the only place that sees the authoritative scanned
    // count, so it both raises the hint (a hand started without a socket
    // relay) and lowers it (all hands settled). The settle window absorbs
    // the commit→emit→scan race so a scan racing a fresh roundStarted
    // relay can't wrongly idle the game clock.
    const scanned = Number(data.data?.scanned ?? 0) || 0;
    if (scanned > 0) {
      crashArenaRunningHands = scanned;
    } else if (
      crashArenaRunningHands > 0 &&
      Date.now() - crashArenaLastStartSeenAt >= CRASH_ARENA_START_SETTLE_MS
    ) {
      crashArenaRunningHands = 0;
    }
  } catch (err) {
    console.warn(
      "[crash-arena] crash sweep failed:",
      err && err.message ? err.message : err,
    );
  } finally {
    // Re-arm on the adaptive cadence: 1s while hands run, 15s when idle.
    scheduleCrashArenaCrashSweep();
  }
}

// Start the crash sweep at the active cadence — a hand may already be in
// flight (e.g. across a realtime-server restart) and must be picked up
// immediately; subsequent ticks adapt to the running-hand hint.
scheduleCrashArenaCrashSweep(CRASH_ARENA_CRASH_SWEEP_INTERVAL_MS);

// ── Generic disconnect grace timer (hex duel / precision / plinko) ────
// Same model as the crash arena timer above, shared by the 1v1 games.
// `onFire` runs when the grace window elapses without a re-join; if it
// returns true the timer is re-armed (bounded) — used to retry
// transiently-failed forfeit API calls.
if (!global.__disconnectGraceTimers) {
  global.__disconnectGraceTimers = new Map();
}
const disconnectGraceTimers = global.__disconnectGraceTimers;

function cancelDisconnectGraceTimer(key) {
  const handle = disconnectGraceTimers.get(key);
  if (handle) {
    clearTimeout(handle.timer);
    disconnectGraceTimers.delete(key);
  }
}

function scheduleDisconnectGraceTimer(
  key,
  onFire,
  {
    delay = CRASH_ARENA_DISCONNECT_GRACE_MS,
    retryDelay = CRASH_ARENA_DISCONNECT_RETRY_MS,
    maxAttempts = CRASH_ARENA_DISCONNECT_MAX_ATTEMPTS,
    attempt = 0,
  } = {},
) {
  cancelDisconnectGraceTimer(key); // replace any existing timer
  const timer = setTimeout(async () => {
    disconnectGraceTimers.delete(key);
    try {
      const wantsRetry = await onFire(attempt);
      if (wantsRetry && attempt + 1 < maxAttempts) {
        scheduleDisconnectGraceTimer(key, onFire, {
          delay: retryDelay,
          retryDelay,
          maxAttempts,
          attempt: attempt + 1,
        });
      }
    } catch (err) {
      console.warn(
        "[disconnect-grace] fire failed:",
        err && err.message ? err.message : err,
      );
    }
  }, delay);
  disconnectGraceTimers.set(key, { timer });
}

// ── Precision due-transition scheduler (the bot's stop as an EVENT) ──────
// The arming countdown and the bot's stop are stored INSTANTS, and the only
// thing that used to turn an instant into a transition was a READ: the round
// opened, the bot stopped, and the round resolved whenever a client happened
// to poll `get-match` next. Worse, a resolution a read performed was never
// announced to anyone — the read path has no socket access, and
// `precision:roundResult` was only ever emitted from the stop handler, in
// reply to a player's own packet. So a round decided by the bot's deadline
// reached the players only when one of them happened to poll, and reached
// nobody else at all.
//
// This scheduler gives those instants a caller that arrives ON TIME. One timer
// per match: it fires at the stored instant, asks Next.js to apply whatever is
// due (`/api/precision/resolve-due`), broadcasts what happened into the match
// room, and re-arms from the next instant the server reports. A match with
// nothing pending arms nothing, so this costs one timer per live round.
//
// It is an ACCELERATOR, never a source of truth: the deadline lives in the
// database and the lazy transition still runs on every read, so a restart, a
// dropped call, or an unreachable Next.js falls back to exactly the previous
// self-healing behaviour instead of stranding a round.
//
// Kicked by: a socket joining the match room (someone is watching), and the
// ready / matchStart broadcast that arms the first round. Every later round
// re-arms itself from the resolution it just broadcast.
const PRECISION_DUE_ROOM_PREFIX = "precision:match:";
/** Slack added to a due instant so a timer that fires a hair early (clock skew
 *  between this process and the route) still finds the transition due. When it
 *  genuinely is not due yet the route returns the SAME instant and we simply
 *  re-arm for the remainder, so this is a floor and never a drift. */
const PRECISION_DUE_EPSILON_MS = 80;
/** Shortest delay we will ever arm, so a stale instant cannot spin the loop. */
const PRECISION_DUE_MIN_DELAY_MS = 25;
/** One retry after a failed resolve call, before leaving it to the poll path. */
const PRECISION_DUE_RETRY_MS = 500;
/** Bound on the resolve call, mirroring the stop proxy's own forward bound. */
const PRECISION_DUE_HTTP_TIMEOUT_MS = 4000;

if (!global.__precisionDueTimers) {
  global.__precisionDueTimers = new Map();
}
const precisionDueTimers = global.__precisionDueTimers;

function cancelPrecisionDue(matchId) {
  const handle = precisionDueTimers.get(matchId);
  if (handle) {
    clearTimeout(handle.timer);
    precisionDueTimers.delete(matchId);
  }
}

/** True when no socket is in this match room. The scheduler exists to give
 *  PRESENT players an on-time resolution; with nobody watching there is nothing
 *  to announce, and the lazy read path stays the backstop. */
function precisionMatchRoomIsEmpty(matchId) {
  const participants = global.__precisionRoomParticipants;
  const set = participants && participants.get(matchId);
  return !set || set.size === 0;
}

function schedulePrecisionDue(matchId, atMs, { retried = false } = {}) {
  if (!matchId) return;
  cancelPrecisionDue(matchId);
  const instant = Number(atMs);
  const delay = Number.isFinite(instant)
    ? Math.max(PRECISION_DUE_MIN_DELAY_MS, instant - Date.now() + PRECISION_DUE_EPSILON_MS)
    : PRECISION_DUE_MIN_DELAY_MS;
  const timer = setTimeout(() => {
    precisionDueTimers.delete(matchId);
    void runPrecisionDue(matchId, { retried });
  }, delay);
  precisionDueTimers.set(matchId, { timer });
}

/** Publish a due transition to the match room, reusing the exact event shapes
 *  the stop handler already emits so every client listener stays as it was. */
function broadcastPrecisionDue(matchId, report) {
  const roomId = `${PRECISION_DUE_ROOM_PREFIX}${matchId}`;
  if (report.decided) {
    io.to(roomId).emit("precision:roundResult", {
      matchId,
      match: report.match,
      bothStopped: true,
      roundWinnerSeat: report.roundWinnerSeat ?? null,
      matchFinished: report.matchFinished === true,
    });
  }
  if (report.matchFinished) {
    io.to(roomId).emit("precision:matchFinished", { matchId, match: report.match });
    cancelPrecisionDue(matchId);
    return;
  }
  if (report.decided || report.revealed) {
    // A decision re-arms the next round (countdown running), and a reveal opens
    // the held round. Both mean "re-read now", which is exactly what the
    // existing `precision:roundArmStart` listener does.
    io.to(roomId).emit("precision:roundArmStart", { matchId, match: report.match });
  }
}

async function runPrecisionDue(matchId, { retried = false } = {}) {
  if (!matchId) return;
  if (precisionMatchRoomIsEmpty(matchId)) {
    cancelPrecisionDue(matchId);
    return;
  }
  try {
    const baseUrl = process.env.NEXTJS_INTERNAL_URL || "http://localhost:3000";
    const headers = { "Content-Type": "application/json" };
    if (process.env.REALTIME_INTERNAL_SECRET) {
      headers["x-internal-secret"] = process.env.REALTIME_INTERNAL_SECRET;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PRECISION_DUE_HTTP_TIMEOUT_MS);
    let payload = null;
    try {
      const res = await fetch(`${baseUrl}/api/precision/resolve-due`, {
        method: "POST",
        headers,
        body: JSON.stringify({ matchId }),
        signal: controller.signal,
      });
      payload = await res.json().catch(() => null);
    } finally {
      clearTimeout(timeout);
    }
    if (!payload || payload.success !== true || !payload.data) {
      if (!retried) {
        schedulePrecisionDue(matchId, Date.now() + PRECISION_DUE_RETRY_MS, { retried: true });
      }
      return;
    }

    const report = payload.data;
    if (report.changed) {
      broadcastPrecisionDue(matchId, report);
      logThrottled(
        "precision:due:fire",
        "[precision] due transition applied: matchId=",
        matchId,
        "revealed=",
        report.revealed,
        "aiStop=",
        report.aiStopApplied,
        "decided=",
        report.decided,
        "finished=",
        report.matchFinished,
      );
    }
    if (report.nextDueAtMs !== null && report.nextDueAtMs !== undefined) {
      schedulePrecisionDue(matchId, report.nextDueAtMs);
      return;
    }
    if (!report.match) return;
    // Nothing left to wake up for: the match is over, or it is a human duel
    // whose remaining transitions arrive as the players' own stop packets.
    cancelPrecisionDue(matchId);
  } catch (err) {
    console.warn(
      "[precision] due transition failed: matchId=",
      matchId,
      "error=",
      err && err.message ? err.message : err,
    );
    if (!retried) {
      schedulePrecisionDue(matchId, Date.now() + PRECISION_DUE_RETRY_MS, { retried: true });
    }
  }
}

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
    // Someone is watching this match now, so give its stored instants a timer:
    // the scheduler reads whatever is due and arms for the next one.
    schedulePrecisionDue(matchId, Date.now());
    // A (re)joining socket means the player is present again — cancel
    // any pending disconnect forfeit timer for this match.
    cancelDisconnectGraceTimer(`precision:${matchId}:${userId}`);
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
    if (set.size === 0) {
      precisionRoomParticipants.delete(matchId);
      // Nobody is watching this match any more, so stop waking up for it. The
      // lazy read path still completes any stored transition on the next read.
      cancelPrecisionDue(matchId);
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
    // A (re)joining socket means the player is present again — cancel
    // any pending disconnect forfeit timer for this match.
    cancelDisconnectGraceTimer(`plinko:${matchId}:${userId}`);
    logThrottled("plinko:join", "[plinko-pvp] participant joined: matchId=", matchId, "userId=", userId);
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
    logThrottled("plinko:leave", "[plinko-pvp] participant left: matchId=", matchId, "userId=", userId);
  }

  // ── Keno PvP room-participant tracking ──────────────────────────
  // Same pattern as slots-pvp so disconnect handling can forfeit
  // abandoned keno-pvp matches to the opponent (and a re-joining
  // socket cancels the pending forfeit timer). Keyed by matchId.
  const KENO_PVP_MATCH_ROOM_PREFIX = "keno-pvp:match:";
  if (!global.__kenoPvpRoomParticipants) {
    global.__kenoPvpRoomParticipants = new Map();
  }
  const kenoPvpRoomParticipants = global.__kenoPvpRoomParticipants;

  function trackKenoPvpJoin(roomId, userId) {
    if (typeof roomId !== "string" || !roomId.startsWith(KENO_PVP_MATCH_ROOM_PREFIX)) {
      return;
    }
    const matchId = roomId.slice(KENO_PVP_MATCH_ROOM_PREFIX.length);
    if (!matchId) return;
    if (!kenoPvpRoomParticipants.has(matchId)) {
      kenoPvpRoomParticipants.set(matchId, new Set());
    }
    kenoPvpRoomParticipants.get(matchId).add(userId);
    // A (re)joining socket means the player is present again — cancel
    // any pending disconnect forfeit timer for this match.
    cancelDisconnectGraceTimer(`keno:${matchId}:${userId}`);
    logThrottled("keno:join", "[keno-pvp] participant joined: matchId=", matchId, "userId=", userId);
  }
  function trackKenoPvpLeave(roomId, userId) {
    if (typeof roomId !== "string" || !roomId.startsWith(KENO_PVP_MATCH_ROOM_PREFIX)) {
      return;
    }
    const matchId = roomId.slice(KENO_PVP_MATCH_ROOM_PREFIX.length);
    if (!matchId) return;
    const set = kenoPvpRoomParticipants.get(matchId);
    if (!set) return;
    set.delete(userId);
    if (set.size === 0) kenoPvpRoomParticipants.delete(matchId);
    logThrottled("keno:leave", "[keno-pvp] participant left: matchId=", matchId, "userId=", userId);
  }

  // ── Memory Grid room-participant tracking ──────────────────────
  // Same pattern as keno-pvp so disconnect handling can forfeit
  // abandoned memory-grid matches to the opponent (and a re-joining
  // socket cancels the pending forfeit timer). Keyed by matchId.
  const MEMORY_GRID_MATCH_ROOM_PREFIX = "memory-grid:match:";
  if (!global.__memoryGridRoomParticipants) {
    global.__memoryGridRoomParticipants = new Map();
  }
  const memoryGridRoomParticipants = global.__memoryGridRoomParticipants;

  function trackMemoryGridJoin(roomId, userId) {
    if (typeof roomId !== "string" || !roomId.startsWith(MEMORY_GRID_MATCH_ROOM_PREFIX)) {
      return;
    }
    const matchId = roomId.slice(MEMORY_GRID_MATCH_ROOM_PREFIX.length);
    if (!matchId) return;
    if (!memoryGridRoomParticipants.has(matchId)) {
      memoryGridRoomParticipants.set(matchId, new Set());
    }
    memoryGridRoomParticipants.get(matchId).add(userId);
    // A (re)joining socket means the player is present again — cancel
    // any pending disconnect forfeit timer for this match.
    cancelDisconnectGraceTimer(`memory-grid:${matchId}:${userId}`);
    logThrottled("memory-grid:join", "[memory-grid] participant joined: matchId=", matchId, "userId=", userId);
  }
  function trackMemoryGridLeave(roomId, userId) {
    if (typeof roomId !== "string" || !roomId.startsWith(MEMORY_GRID_MATCH_ROOM_PREFIX)) {
      return;
    }
    const matchId = roomId.slice(MEMORY_GRID_MATCH_ROOM_PREFIX.length);
    if (!matchId) return;
    const set = memoryGridRoomParticipants.get(matchId);
    if (!set) return;
    set.delete(userId);
    if (set.size === 0) memoryGridRoomParticipants.delete(matchId);
    logThrottled("memory-grid:leave", "[memory-grid] participant left: matchId=", matchId, "userId=", userId);
  }

  // ── Roulette PvP room-participant tracking ──────────────────────
  // Same pattern as keno-pvp so disconnect handling can forfeit
  // abandoned matches to the opponent (and a re-joining socket
  // cancels the pending forfeit timer). Keyed by matchId.
  const ROULETTE_PVP_MATCH_ROOM_PREFIX = "roulette-pvp:match:";
  if (!global.__roulettePvpRoomParticipants) {
    global.__roulettePvpRoomParticipants = new Map();
  }
  const roulettePvpRoomParticipants = global.__roulettePvpRoomParticipants;

  function trackRoulettePvpJoin(roomId, userId) {
    if (typeof roomId !== "string" || !roomId.startsWith(ROULETTE_PVP_MATCH_ROOM_PREFIX)) {
      return;
    }
    const matchId = roomId.slice(ROULETTE_PVP_MATCH_ROOM_PREFIX.length);
    if (!matchId) return;
    if (!roulettePvpRoomParticipants.has(matchId)) {
      roulettePvpRoomParticipants.set(matchId, new Set());
    }
    roulettePvpRoomParticipants.get(matchId).add(userId);
    cancelDisconnectGraceTimer(`roulette:${matchId}:${userId}`);
    logThrottled("roulette:join", "[roulette-pvp] participant joined: matchId=", matchId, "userId=", userId);
  }
  function trackRoulettePvpLeave(roomId, userId) {
    if (typeof roomId !== "string" || !roomId.startsWith(ROULETTE_PVP_MATCH_ROOM_PREFIX)) {
      return;
    }
    const matchId = roomId.slice(ROULETTE_PVP_MATCH_ROOM_PREFIX.length);
    if (!matchId) return;
    const set = roulettePvpRoomParticipants.get(matchId);
    if (!set) return;
    set.delete(userId);
    if (set.size === 0) roulettePvpRoomParticipants.delete(matchId);
    logThrottled("roulette:leave", "[roulette-pvp] participant left: matchId=", matchId, "userId=", userId);
  }

  // ── RPS PvP room-participant tracking ───────────────────────────
  // Poll-based game (no per-match state on the socket), but the match
  // view joins a dedicated room so disconnect handling can forfeit
  // abandoned best-of-7 games to the opponent. Keyed by gameId.
  const RPS_PVP_MATCH_ROOM_PREFIX = "rps-pvp:match:";
  if (!global.__rpsPvpRoomParticipants) {
    global.__rpsPvpRoomParticipants = new Map();
  }
  const rpsPvpRoomParticipants = global.__rpsPvpRoomParticipants;

  function trackRpsPvpJoin(roomId, userId) {
    if (typeof roomId !== "string" || !roomId.startsWith(RPS_PVP_MATCH_ROOM_PREFIX)) {
      return;
    }
    const gameId = roomId.slice(RPS_PVP_MATCH_ROOM_PREFIX.length);
    if (!gameId) return;
    if (!rpsPvpRoomParticipants.has(gameId)) {
      rpsPvpRoomParticipants.set(gameId, new Set());
    }
    rpsPvpRoomParticipants.get(gameId).add(userId);
    cancelDisconnectGraceTimer(`rps:${gameId}:${userId}`);
    logThrottled("rps:join", "[rps-pvp] participant joined: gameId=", gameId, "userId=", userId);
  }
  function trackRpsPvpLeave(roomId, userId) {
    if (typeof roomId !== "string" || !roomId.startsWith(RPS_PVP_MATCH_ROOM_PREFIX)) {
      return;
    }
    const gameId = roomId.slice(RPS_PVP_MATCH_ROOM_PREFIX.length);
    if (!gameId) return;
    const set = rpsPvpRoomParticipants.get(gameId);
    if (!set) return;
    set.delete(userId);
    if (set.size === 0) rpsPvpRoomParticipants.delete(gameId);
    logThrottled("rps:leave", "[rps-pvp] participant left: gameId=", gameId, "userId=", userId);
  }

  // ── Tower Arena room-participant tracking ─────────────────────────
  // Poll-based game; the match view joins a dedicated room so
  // disconnect handling can drop a missing player (placed last) while
  // the remaining players keep playing. Keyed by matchId.
  const TOWER_ARENA_MATCH_ROOM_PREFIX = "tower-arena:match:";
  if (!global.__towerArenaRoomParticipants) {
    global.__towerArenaRoomParticipants = new Map();
  }
  const towerArenaRoomParticipants = global.__towerArenaRoomParticipants;

  function trackTowerArenaJoin(roomId, userId) {
    if (typeof roomId !== "string" || !roomId.startsWith(TOWER_ARENA_MATCH_ROOM_PREFIX)) {
      return;
    }
    const matchId = roomId.slice(TOWER_ARENA_MATCH_ROOM_PREFIX.length);
    if (!matchId) return;
    if (!towerArenaRoomParticipants.has(matchId)) {
      towerArenaRoomParticipants.set(matchId, new Set());
    }
    towerArenaRoomParticipants.get(matchId).add(userId);
    cancelDisconnectGraceTimer(`tower-arena:${matchId}:${userId}`);
    logThrottled("tower-arena:join", "[tower-arena] participant joined: matchId=", matchId, "userId=", userId);
  }
  function trackTowerArenaLeave(roomId, userId) {
    if (typeof roomId !== "string" || !roomId.startsWith(TOWER_ARENA_MATCH_ROOM_PREFIX)) {
      return;
    }
    const matchId = roomId.slice(TOWER_ARENA_MATCH_ROOM_PREFIX.length);
    if (!matchId) return;
    const set = towerArenaRoomParticipants.get(matchId);
    if (!set) return;
    set.delete(userId);
    if (set.size === 0) towerArenaRoomParticipants.delete(matchId);
    logThrottled("tower-arena:leave", "[tower-arena] participant left: matchId=", matchId, "userId=", userId);
  }

  // ── Mini Golf room-participant tracking ─────────────────────────
  // Same pattern as keno-pvp / memory-grid so disconnect handling can forfeit
  // an abandoned 1v1 match to the opponent (and a re-joining socket cancels the
  // pending forfeit timer). Keyed by matchId (a uuid).
  const MINI_GOLF_MATCH_ROOM_PREFIX = "mini-golf:match:";
  if (!global.__miniGolfRoomParticipants) {
    global.__miniGolfRoomParticipants = new Map();
  }
  const miniGolfRoomParticipants = global.__miniGolfRoomParticipants;

  function trackMiniGolfJoin(roomId, userId) {
    if (typeof roomId !== "string" || !roomId.startsWith(MINI_GOLF_MATCH_ROOM_PREFIX)) {
      return;
    }
    const matchId = roomId.slice(MINI_GOLF_MATCH_ROOM_PREFIX.length);
    if (!matchId) return;
    if (!miniGolfRoomParticipants.has(matchId)) {
      miniGolfRoomParticipants.set(matchId, new Set());
    }
    miniGolfRoomParticipants.get(matchId).add(userId);
    // A (re)joining socket means the player is present again — cancel any
    // pending disconnect forfeit timer for this match.
    cancelDisconnectGraceTimer(`mini-golf:${matchId}:${userId}`);
    logThrottled("mini-golf:join", "[mini-golf] participant joined: matchId=", matchId, "userId=", userId);
  }
  function trackMiniGolfLeave(roomId, userId) {
    if (typeof roomId !== "string" || !roomId.startsWith(MINI_GOLF_MATCH_ROOM_PREFIX)) {
      return;
    }
    const matchId = roomId.slice(MINI_GOLF_MATCH_ROOM_PREFIX.length);
    if (!matchId) return;
    const set = miniGolfRoomParticipants.get(matchId);
    if (!set) return;
    set.delete(userId);
    if (set.size === 0) miniGolfRoomParticipants.delete(matchId);
    logThrottled("mini-golf:leave", "[mini-golf] participant left: matchId=", matchId, "userId=", userId);
  }

  // ── Crash Arena room-participant tracking ───────────────────────
  // Mirrors the plinko/precision tracking pattern so the
  // `crashArena:updated` handler below can reject events from
  // non-participant sockets. Keyed by tableId (numeric).
  if (!global.__crashArenaRoomParticipants) {
    global.__crashArenaRoomParticipants = new Map();
  }
  const crashArenaRoomParticipants = global.__crashArenaRoomParticipants;

  function trackCrashArenaJoin(roomId, userId) {
    if (typeof roomId !== "string" || !roomId.startsWith(CRASH_ARENA_MATCH_ROOM_PREFIX)) {
      return;
    }
    const tableId = roomId.slice(CRASH_ARENA_MATCH_ROOM_PREFIX.length);
    if (!tableId) return;
    if (!crashArenaRoomParticipants.has(tableId)) {
      crashArenaRoomParticipants.set(tableId, new Set());
    }
    crashArenaRoomParticipants.get(tableId).add(userId);
    // A (re)joining socket means the player is present again — cancel
    // any pending disconnect cleanup so refreshes keep the seat.
    cancelCrashArenaDisconnectTimer(userId, tableId);
    logThrottled("crash:join", "[crash-arena] participant joined: tableId=", tableId, "userId=", userId);
  }
  function trackCrashArenaLeave(roomId, userId) {
    if (typeof roomId !== "string" || !roomId.startsWith(CRASH_ARENA_MATCH_ROOM_PREFIX)) {
      return;
    }
    const tableId = roomId.slice(CRASH_ARENA_MATCH_ROOM_PREFIX.length);
    if (!tableId) return;
    const set = crashArenaRoomParticipants.get(tableId);
    if (!set) return;
    set.delete(userId);
    if (set.size === 0) crashArenaRoomParticipants.delete(tableId);
    logThrottled("crash:leave", "[crash-arena] participant left: tableId=", tableId, "userId=", userId);
  }
  socket.on("join_room", ({ roomId }) => {
    if (!roomId) return;
    // The admin notifications room must NEVER be joinable via the generic
    // path — only the verified `admin:join` handler below may enter it.
    if (String(roomId) === ADMIN_NOTIFICATIONS_ROOM) return;
    socket.join(String(roomId));
    trackPrecisionJoin(String(roomId), socket.data.userId);
    trackPlinkoJoin(String(roomId), socket.data.userId);
    trackKenoPvpJoin(String(roomId), socket.data.userId);
    trackMemoryGridJoin(String(roomId), socket.data.userId);
    trackCrashArenaJoin(String(roomId), socket.data.userId);
    trackRoulettePvpJoin(String(roomId), socket.data.userId);
    trackRpsPvpJoin(String(roomId), socket.data.userId);
    trackTowerArenaJoin(String(roomId), socket.data.userId);
    trackMiniGolfJoin(String(roomId), socket.data.userId);
  });

  // ── Admin notifications room join ──────────────────────────────────
  // Re-verifies admin status server-side (Clerk token → Next.js isAdmin)
  // before allowing the socket into the admin-only room. Fails closed on
  // any error / unreachable Next.js. The client re-emits on socket
  // reconnect (Socket.IO does not restore room membership automatically).
  socket.on("admin:join", async (ack) => {
    const allow = async () => {
      try {
        const baseUrl = process.env.NEXTJS_INTERNAL_URL || "http://localhost:3000";
        const res = await fetch(`${baseUrl}/api/admin/socket-verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: socket.data.clerkToken }),
        });
        const payload = await res.json().catch(() => null);
        return payload && payload.success === true && payload.isAdmin === true;
      } catch {
        return false;
      }
    };
    if (await allow()) {
      socket.join(ADMIN_NOTIFICATIONS_ROOM);
      if (typeof ack === "function") ack({ success: true });
    } else {
      socket.leave(ADMIN_NOTIFICATIONS_ROOM);
      if (typeof ack === "function") ack({ success: false, error: "Not an admin." });
    }
  });

  socket.on("admin:leave", () => {
    socket.leave(ADMIN_NOTIFICATIONS_ROOM);
  });

  socket.on("leave_room", ({ roomId }) => {
    if (!roomId) return;
    socket.leave(String(roomId));
    trackPrecisionLeave(String(roomId), socket.data.userId);
    trackPlinkoLeave(String(roomId), socket.data.userId);
    trackKenoPvpLeave(String(roomId), socket.data.userId);
    trackMemoryGridLeave(String(roomId), socket.data.userId);
    trackCrashArenaLeave(String(roomId), socket.data.userId);
    trackRoulettePvpLeave(String(roomId), socket.data.userId);
    trackRpsPvpLeave(String(roomId), socket.data.userId);
    trackTowerArenaLeave(String(roomId), socket.data.userId);
    trackMiniGolfLeave(String(roomId), socket.data.userId);
  });

  // The first round is armed by an HTTP ready call, and this broadcast is the
  // only signal a live client gives that a stored instant now exists — so it is
  // what arms the scheduler for the opening countdown and, through it, for the
  // bot's first stop.
  const PRECISION_ARMING_EVENTS = new Set(["precision:playerReady", "precision:matchStart"]);
  socket.on("room_event", ({ roomId, event, payload }) => {
    if (PRECISION_ARMING_EVENTS.has(String(event))) {
      const room = String(roomId || "");
      if (room.startsWith(PRECISION_DUE_ROOM_PREFIX)) {
        schedulePrecisionDue(room.slice(PRECISION_DUE_ROOM_PREFIX.length), Date.now());
      }
    }
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
    logThrottled("hex-duel:relay", "[hex-duel] relay:", roomId, "from=", userId, "type=", action.type, "player=", action.player, "seq=", thisSeq, "roomSize=", roomSize);
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

    // Re-joining cancels the disconnect grace timer for this game and
    // tells the opponent they're back (dismisses the "reconnecting"
    // banner they've been seeing).
    cancelDisconnectGraceTimer(`hexDuel:${String(gameId)}:${socket.data.userId}`);
    socket.to(roomId).emit("hexDuel:opponent:reconnected", {
      gameId: roomId,
      userId: socket.data.userId,
    });

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
  // participant of the requested precision match (tracked above), then
  // proxy the bare stop signal (never a client-supplied stopMs) to the
  // Next.js `/api/precision/round-stop` route via HTTP.
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
  socket.on("precision:stop", async ({ matchId, roundId, nonce, elapsedMs } = {}, ack) => {
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
    // Bounded forward: if Next.js hangs or drops the connection, the
    // Promise would never resolve, the `ack(...)` callback would never
    // fire, and the client's STOP button would stay permanently
    // disabled (locked by `stopSubmitting = true`). Mirrors the
    // pool/dice/farkle realtime proxies in this file.
    const forwardController = new AbortController();
    const forwardTimeout = setTimeout(
      () => forwardController.abort(),
      4000,
    );
    try {
      const baseUrl = process.env.NEXTJS_INTERNAL_URL || "http://localhost:3000";
      const res = await fetch(
        `${baseUrl}/api/precision/round-stop`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            matchId: matchIdStr,
            // The route verifies identity server-side: it accepts the
            // player's raw Clerk session token (the realtime server has
            // no Clerk HTTP session of its own) and derives userId from
            // it, so a forged body.userId is impossible.
            token: socket.data.clerkToken,
            roundId: roundIdStr,
            nonce: nonceStr,
            // The player's own frozen elapsed (the number on their screen when
            // they clicked), forwarded verbatim as a HINT. The Next.js route
            // clamps it against its own receive-time measurement, so the
            // realtime layer stays as dumb about timing as it always was —
            // it forwards a value, it never decides one.
            ...(Number.isFinite(Number(elapsedMs))
              ? { elapsedMs: Number(elapsedMs) }
              : {}),
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
            error: (payload && payload.error) || "Stop rejected by server.",
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
          // armMatchRound has already armed the next round; emit
          // roundArmStart so the opponent flips to the "Get ready…"
          // screen without waiting for the poll.
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
      console.warn(
        "[precision] round-stop proxy failed: matchId=",
        matchIdStr,
        "error=",
        err && err.message ? err.message : err,
      );
      if (typeof ack === "function") {
        const isAbort = err && (err.name === "AbortError" || /aborted/i.test(String(err.message)));
        ack({
          success: false,
          error: isAbort
            ? "Stop timed out before the server confirmed. Please try again."
            : ((err && err.message) || "Realtime proxy unreachable."),
        });
      }
    } finally {
      // Always disarm the abort timer — a late abort after a successful
      // response would otherwise abort a completed request object (and
      // keeps the timer from holding a reference until it fires).
      clearTimeout(forwardTimeout);
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
    logThrottled("plinko:relayReady", "[plinko-pvp] relay ready: matchId=", matchIdStr,
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

  // ── Mini Golf: ready ───────────────────────────────────────────
  // The client emits `mini-golf:ready` after a successful /shoot or /forfeit
  // POST so the opponent gets an instant refresh push instead of waiting for
  // the next poll. The handler validates that the caller is a tracked
  // participant of that match, then relays `lobby:updated` to the room
  // (excluding the sender). The generic `room_event` path still works as a
  // fallback.
  socket.on("mini-golf:ready", ({ matchId } = {}) => {
    if (!matchId) return;
    const matchIdStr = String(matchId);
    // matchId is a uuid — keep the character set tight so a malformed id can
    // never build a surprising room name.
    if (!/^[0-9a-fA-F-]{1,64}$/.test(matchIdStr)) return;
    const participants = miniGolfRoomParticipants.get(matchIdStr);
    if (!participants || !participants.has(socket.data.userId)) {
      logThrottled(
        "mini-golf:rejectReady",
        "[mini-golf] rejecting ready from non-participant: matchId=",
        matchIdStr,
        "userId=",
        socket.data.userId,
      );
      return;
    }
    const roomId = `${MINI_GOLF_MATCH_ROOM_PREFIX}${matchIdStr}`;
    socket.to(roomId).emit("lobby:updated", {
      matchId: matchIdStr,
      userId: socket.data.userId,
      sentAt: new Date().toISOString(),
    });
  });

  // ── Crash Arena: table update ─────────────────────────────────
  // The client emits `crashArena:updated` after a successful API
  // mutation (start-round, fold, crash/settle, join, leave) so
  // the rest of the table gets an instant `lobby:updated` push
  // instead of waiting for the 5s poll. Mirrors the `plinko:ready`
  // handler: rejects events from non-participant sockets and from
  // non-numeric tableIds (belt-and-suspenders against path-style
  // room constructions).
  socket.on("crashArena:updated", ({ tableId, ...payload } = {}) => {
    if (!tableId) return;
    const tableIdStr = String(tableId);
    if (!/^\d+$/.test(tableIdStr)) {
      console.warn(
        "[crash-arena] rejecting crashArena:updated with non-numeric tableId:",
        tableIdStr,
        "userId=",
        socket.data.userId,
      );
      return;
    }
    const participants = crashArenaRoomParticipants.get(tableIdStr);
    if (!participants || !participants.has(socket.data.userId)) {
      console.warn(
        "[crash-arena] rejecting crashArena:updated from non-participant: tableId=",
        tableIdStr,
        "userId=",
        socket.data.userId,
        "participantCount=",
        participants ? participants.size : 0,
      );
      return;
    }
    // A hand just started on this table — bump the running-hand hint so the
    // crash sweep resumes its 1s game-clock cadence immediately if it was
    // idling at the liveness interval (a fresh hand's first checkpoint is
    // due within seconds). Duplicate relays only inflate the hint
    // transiently — the next sweep tick reconciles it to the scanned count.
    if (payload?.roundStarted === true) {
      crashArenaRunningHands += 1;
      crashArenaLastStartSeenAt = Date.now();
      scheduleCrashArenaCrashSweep();
    }

    const roomId = `${CRASH_ARENA_MATCH_ROOM_PREFIX}${tableIdStr}`;
    const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
    logThrottled("crash-arena:relayUpdate", "[crash-arena] relay update: tableId=",
      tableIdStr,
      "from=",
      socket.data.userId,
      "roomSize=",
      socketsInRoom ? socketsInRoom.size : 0,
    );
    socket.to(roomId).emit("lobby:updated", {
      tableId: tableIdStr,
      ...(payload && typeof payload === "object" ? payload : {}),
      userId: socket.data.userId,
      sentAt: new Date().toISOString(),
    });
  });

  // ── Keep existing disconnect handler ──
  socket.on("disconnect", () => {
    // For Precision: for each match the user was a participant of, keep
    // the participant entry when another tab is still connected, else
    // drop it and arm a disconnect grace timer. When the timer expires
    // without the user re-joining, the match is forfeited to the
    // opponent via /api/precision/disconnect-forfeit.
    const precisionMatchesForUser = [];
    for (const [mid, set] of precisionRoomParticipants.entries()) {
      if (set.has(socket.data.userId)) precisionMatchesForUser.push(mid);
    }
    for (const mid of precisionMatchesForUser) {
      const roomId = `${PRECISION_MATCH_ROOM_PREFIX}${mid}`;
      if (hasLiveSocketForUser(socket.data.userId, roomId)) continue;
      const set = precisionRoomParticipants.get(mid);
      if (set) {
        set.delete(socket.data.userId);
        if (set.size === 0) precisionRoomParticipants.delete(mid);
      }
      scheduleDisconnectGraceTimer(`precision:${mid}:${socket.data.userId}`, async () => {
        if (hasLiveSocketForUser(socket.data.userId, roomId)) return false;
        try {
          const baseUrl = process.env.NEXTJS_INTERNAL_URL || "http://localhost:3000";
          const res = await fetch(`${baseUrl}/api/precision/disconnect-forfeit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ matchId: mid, token: socket.data.clerkToken }),
          });
          const payload = await res.json().catch(() => null);
          return !(payload && payload.success === true);
        } catch (err) {
          console.warn(
            "[precision] disconnect forfeit failed:",
            err && err.message ? err.message : err,
          );
          return true; // transient — retry
        }
      });
    }

    // For Plinko PvP: same pattern — forfeit to the opponent via
    // /api/plinko-pvp/disconnect-forfeit once the grace timer expires.
    const plinkoMatchesForUser = [];
    for (const [mid, set] of plinkoRoomParticipants.entries()) {
      if (set.has(socket.data.userId)) plinkoMatchesForUser.push(mid);
    }
    for (const mid of plinkoMatchesForUser) {
      const roomId = `${PLINKO_MATCH_ROOM_PREFIX}${mid}`;
      if (hasLiveSocketForUser(socket.data.userId, roomId)) continue;
      const set = plinkoRoomParticipants.get(mid);
      if (set) {
        set.delete(socket.data.userId);
        if (set.size === 0) plinkoRoomParticipants.delete(mid);
      }
      scheduleDisconnectGraceTimer(`plinko:${mid}:${socket.data.userId}`, async () => {
        if (hasLiveSocketForUser(socket.data.userId, roomId)) return false;
        try {
          const baseUrl = process.env.NEXTJS_INTERNAL_URL || "http://localhost:3000";
          const res = await fetch(`${baseUrl}/api/plinko-pvp/disconnect-forfeit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ matchId: mid, token: socket.data.clerkToken }),
          });
          const payload = await res.json().catch(() => null);
          return !(payload && payload.success === true);
        } catch (err) {
          console.warn(
            "[plinko-pvp] disconnect forfeit failed:",
            err && err.message ? err.message : err,
          );
          return true; // transient — retry
        }
      });
    }

    // For Keno PvP: same pattern — forfeit to the opponent via
    // /api/keno-pvp/disconnect-forfeit once the grace timer expires.
    const kenoPvpMatchesForUser = [];
    for (const [mid, set] of kenoPvpRoomParticipants.entries()) {
      if (set.has(socket.data.userId)) kenoPvpMatchesForUser.push(mid);
    }
    for (const mid of kenoPvpMatchesForUser) {
      const roomId = `${KENO_PVP_MATCH_ROOM_PREFIX}${mid}`;
      if (hasLiveSocketForUser(socket.data.userId, roomId)) continue;
      const set = kenoPvpRoomParticipants.get(mid);
      if (set) {
        set.delete(socket.data.userId);
        if (set.size === 0) kenoPvpRoomParticipants.delete(mid);
      }
      scheduleDisconnectGraceTimer(`keno:${mid}:${socket.data.userId}`, async () => {
        if (hasLiveSocketForUser(socket.data.userId, roomId)) return false;
        try {
          const baseUrl = process.env.NEXTJS_INTERNAL_URL || "http://localhost:3000";
          const res = await fetch(`${baseUrl}/api/keno-pvp/disconnect-forfeit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ matchId: mid, token: socket.data.clerkToken }),
          });
          const payload = await res.json().catch(() => null);
          return !(payload && payload.success === true);
        } catch (err) {
          console.warn(
            "[keno-pvp] disconnect forfeit failed:",
            err && err.message ? err.message : err,
          );
          return true; // transient — retry
        }
      });
    }

    // For Memory Grid: same pattern as keno-pvp — forfeit to the
    // opponent via /api/memory-grid/disconnect-forfeit once the grace
    // timer expires. A player who closes the tab / reloads the page
    // mid-match (memorize, reconstruct, after submitting) or abandons
    // the lobby is confirmed-gone after the grace window, and the
    // match resolves as a win for the opponent instead of staying
    // stuck forever.
    const memoryGridMatchesForUser = [];
    for (const [mid, set] of memoryGridRoomParticipants.entries()) {
      if (set.has(socket.data.userId)) memoryGridMatchesForUser.push(mid);
    }
    for (const mid of memoryGridMatchesForUser) {
      const roomId = `${MEMORY_GRID_MATCH_ROOM_PREFIX}${mid}`;
      if (hasLiveSocketForUser(socket.data.userId, roomId)) continue;
      const set = memoryGridRoomParticipants.get(mid);
      if (set) {
        set.delete(socket.data.userId);
        if (set.size === 0) memoryGridRoomParticipants.delete(mid);
      }
      scheduleDisconnectGraceTimer(`memory-grid:${mid}:${socket.data.userId}`, async () => {
        if (hasLiveSocketForUser(socket.data.userId, roomId)) return false;
        try {
          const baseUrl = process.env.NEXTJS_INTERNAL_URL || "http://localhost:3000";
          const res = await fetch(`${baseUrl}/api/memory-grid/disconnect-forfeit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ matchId: mid, token: socket.data.clerkToken }),
          });
          const payload = await res.json().catch(() => null);
          return !(payload && payload.success === true);
        } catch (err) {
          console.warn(
            "[memory-grid] disconnect forfeit failed:",
            err && err.message ? err.message : err,
          );
          return true; // transient — retry
        }
      });
    }

    // For Roulette PvP: same pattern — forfeit to the opponent via
    // /api/roulette-pvp/disconnect-forfeit once the grace timer
    // expires (covers the both-players-gone case the AFK round
    // resolution can't).
    const roulettePvpMatchesForUser = [];
    for (const [mid, set] of roulettePvpRoomParticipants.entries()) {
      if (set.has(socket.data.userId)) roulettePvpMatchesForUser.push(mid);
    }
    for (const mid of roulettePvpMatchesForUser) {
      const roomId = `${ROULETTE_PVP_MATCH_ROOM_PREFIX}${mid}`;
      if (hasLiveSocketForUser(socket.data.userId, roomId)) continue;
      const set = roulettePvpRoomParticipants.get(mid);
      if (set) {
        set.delete(socket.data.userId);
        if (set.size === 0) roulettePvpRoomParticipants.delete(mid);
      }
      scheduleDisconnectGraceTimer(`roulette:${mid}:${socket.data.userId}`, async () => {
        if (hasLiveSocketForUser(socket.data.userId, roomId)) return false;
        try {
          const baseUrl = process.env.NEXTJS_INTERNAL_URL || "http://localhost:3000";
          const res = await fetch(`${baseUrl}/api/roulette-pvp/disconnect-forfeit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ matchId: mid, token: socket.data.clerkToken }),
          });
          const payload = await res.json().catch(() => null);
          return !(payload && payload.success === true);
        } catch (err) {
          console.warn(
            "[roulette-pvp] disconnect forfeit failed:",
            err && err.message ? err.message : err,
          );
          return true; // transient — retry
        }
      });
    }

    // For RPS PvP: same pattern — forfeit to the opponent via
    // /api/rps/pvp/disconnect-forfeit once the grace timer expires.
    const rpsPvpGamesForUser = [];
    for (const [gid, set] of rpsPvpRoomParticipants.entries()) {
      if (set.has(socket.data.userId)) rpsPvpGamesForUser.push(gid);
    }
    for (const gid of rpsPvpGamesForUser) {
      const roomId = `${RPS_PVP_MATCH_ROOM_PREFIX}${gid}`;
      if (hasLiveSocketForUser(socket.data.userId, roomId)) continue;
      const set = rpsPvpRoomParticipants.get(gid);
      if (set) {
        set.delete(socket.data.userId);
        if (set.size === 0) rpsPvpRoomParticipants.delete(gid);
      }
      scheduleDisconnectGraceTimer(`rps:${gid}:${socket.data.userId}`, async () => {
        if (hasLiveSocketForUser(socket.data.userId, roomId)) return false;
        try {
          const baseUrl = process.env.NEXTJS_INTERNAL_URL || "http://localhost:3000";
          const res = await fetch(`${baseUrl}/api/rps/pvp/disconnect-forfeit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gameId: gid, token: socket.data.clerkToken }),
          });
          const payload = await res.json().catch(() => null);
          return !(payload && payload.success === true);
        } catch (err) {
          console.warn(
            "[rps-pvp] disconnect forfeit failed:",
            err && err.message ? err.message : err,
          );
          return true; // transient — retry
        }
      });
    }

    // For Tower Arena: a disconnected player is dropped (placed last)
    // via /api/tower-arena/disconnect-forfeit once the grace timer
    // expires; the remaining players continue the match.
    const towerArenaMatchesForUser = [];
    for (const [mid, set] of towerArenaRoomParticipants.entries()) {
      if (set.has(socket.data.userId)) towerArenaMatchesForUser.push(mid);
    }
    for (const mid of towerArenaMatchesForUser) {
      const roomId = `${TOWER_ARENA_MATCH_ROOM_PREFIX}${mid}`;
      if (hasLiveSocketForUser(socket.data.userId, roomId)) continue;
      const set = towerArenaRoomParticipants.get(mid);
      if (set) {
        set.delete(socket.data.userId);
        if (set.size === 0) towerArenaRoomParticipants.delete(mid);
      }
      scheduleDisconnectGraceTimer(`tower-arena:${mid}:${socket.data.userId}`, async () => {
        if (hasLiveSocketForUser(socket.data.userId, roomId)) return false;
        try {
          const baseUrl = process.env.NEXTJS_INTERNAL_URL || "http://localhost:3000";
          const res = await fetch(`${baseUrl}/api/tower-arena/disconnect-forfeit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ matchId: mid, token: socket.data.clerkToken }),
          });
          const payload = await res.json().catch(() => null);
          return !(payload && payload.success === true);
        } catch (err) {
          console.warn(
            "[tower-arena] disconnect forfeit failed:",
            err && err.message ? err.message : err,
          );
          return true; // transient — retry
        }
      });
    }

    // For Crash Arena: for each table the user was a participant of,
    // check whether another tab/socket of the same user is still
    // connected. If one is, keep the user in the participant set (so
    // the remaining tab keeps broadcasting) and skip the timer. If not,
    // drop the user from that table's participants and arm a grace
    // timer — when it expires without the user re-joining (a refresh /
    // reconnect cancels it), their seat + table balance are released.
    const crashArenaTablesForUser = [];
    for (const [tid, set] of crashArenaRoomParticipants.entries()) {
      if (set.has(socket.data.userId)) crashArenaTablesForUser.push(tid);
    }
    for (const tid of crashArenaTablesForUser) {
      const roomId = `${CRASH_ARENA_MATCH_ROOM_PREFIX}${tid}`;
      if (hasLiveSocketForUser(socket.data.userId, roomId)) continue;
      const set = crashArenaRoomParticipants.get(tid);
      if (set) {
        set.delete(socket.data.userId);
        if (set.size === 0) crashArenaRoomParticipants.delete(tid);
      }
      scheduleCrashArenaDisconnectCleanup(
        socket.data.userId,
        socket.data.clerkToken,
        tid,
      );
    }

    // For Mini Golf: same pattern as keno-pvp / memory-grid — forfeit an
    // abandoned match to the opponent (or cancel an empty lobby) via
    // /api/mini-golf/disconnect-forfeit once the grace timer expires.
    const miniGolfMatchesForUser = [];
    for (const [mid, set] of miniGolfRoomParticipants.entries()) {
      if (set.has(socket.data.userId)) miniGolfMatchesForUser.push(mid);
    }
    for (const mid of miniGolfMatchesForUser) {
      const roomId = `${MINI_GOLF_MATCH_ROOM_PREFIX}${mid}`;
      if (hasLiveSocketForUser(socket.data.userId, roomId)) continue;
      const set = miniGolfRoomParticipants.get(mid);
      if (set) {
        set.delete(socket.data.userId);
        if (set.size === 0) miniGolfRoomParticipants.delete(mid);
      }
      scheduleDisconnectGraceTimer(`mini-golf:${mid}:${socket.data.userId}`, async () => {
        if (hasLiveSocketForUser(socket.data.userId, roomId)) return false;
        try {
          const baseUrl = process.env.NEXTJS_INTERNAL_URL || "http://localhost:3000";
          const res = await fetch(`${baseUrl}/api/mini-golf/disconnect-forfeit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ matchId: mid, token: socket.data.clerkToken }),
          });
          const payload = await res.json().catch(() => null);
          return !(payload && payload.success === true);
        } catch (err) {
          console.warn(
            "[mini-golf] disconnect forfeit failed:",
            err && err.message ? err.message : err,
          );
          return true; // transient — retry
        }
      });
    }

    // For hex duel: arm a grace timer per game instead of instantly
    // declaring the opponent win, so a quick refresh / reconnect isn't a
    // loss. Only games this user actually joined are processed (mirrors
    // the per-user enumeration used for precision / plinko / crash
    // arena above — never iterate the global hexDuelGameIds set, which
    // contains unrelated games and would arm spurious timers). The
    // opponent is told they're waiting ("reconnecting" banner); if the
    // player rejoins (hexDuel:join) the timer cancels and the opponent
    // is told they're back. Only when the grace window expires is the
    // disconnect event emitted (opponent auto-wins).
    const hexDuelGamesForUser = [];
    for (const [gid, set] of hexDuelRoomPlayers.entries()) {
      if (set.has(socket.data.userId)) hexDuelGamesForUser.push(gid);
    }
    for (const gid of hexDuelGamesForUser) {
      const roomId = String(gid);
      if (hasLiveSocketForUser(socket.data.userId, roomId)) continue;
      const players = hexDuelRoomPlayers.get(String(gid));
      if (players) {
        players.delete(socket.data.userId);
        if (players.size === 0) hexDuelRoomPlayers.delete(String(gid));
      }
      socket.to(roomId).emit("hexDuel:opponent:reconnecting", {
        gameId: roomId,
        userId: socket.data.userId,
      });
      scheduleDisconnectGraceTimer(`hexDuel:${gid}:${socket.data.userId}`, async () => {
        if (hasLiveSocketForUser(socket.data.userId, roomId)) return false;
        // Grace expired — the opponent now wins (client declares it
        // via the existing end-game flow). Emission is terminal.
        io.to(roomId).emit("hexDuel:opponent:disconnected", {
          gameId: roomId,
          userId: socket.data.userId,
        });
        return false;
      });
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
      logThrottled("pool:shot", "[pool] shot", matchId, userId, effectiveShotId);
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
      logThrottled("pool:turn", "[pool] turn switched", matchId, m.turnUserId);
    },
  );
}
