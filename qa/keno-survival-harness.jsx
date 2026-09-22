// qa/keno-survival-harness.jsx
//
// Integration harness for the Keno SURVIVAL DUEL match UI. It mounts the
// REAL `src/app/casino/keno-pvp/[matchId]/PageClient.jsx` (only the noisy
// siblings are stubbed by qa/keno-survival-check.mjs: Clerk, the socket, the
// router, analytics, nav/footer, the waiting takeover and the creator-mode
// HOST — the creator-mode LAYOUT stays real, so the portrait frame under test
// is the shipped one) and feeds it a scripted survival run through a stubbed
// `fetch`, exactly like the GET route's viewer payload.
//
// The stub also PLAYS the server: a POST to /catch on the tile the run says is
// live claims it (credit the tile, drop the opponent's life, light the next
// tile), and a POST on any other tile is refused — the same accept/reject
// shape as `claimTile`.
//
// Everything the check needs is on `window.__ks`:
//   * `match(overrides)`   — the payload the route would return for the viewer
//   * `set(overrides)`     — install a payload WITHOUT announcing it
//   * `pushLog(entry, o)`  — append ONE resolved tile to the public log and
//                            broadcast the room event (the real path)
//   * `redeliver()`        — re-send the CURRENT payload (the poll/socket
//                            repeats-a-snapshot case)
//   * `posts`              — every POST body the page sent, in order
//   * `cues`               — every gameAudio call the page made, in order
//   * `setPortrait(bool)`  — flip the creator-mode dimensions to 9:16
//   * `mount()` / `unmount()`

import React from "react";
import { createRoot } from "react-dom/client";
import KenoPvpMatchPage from "../src/app/casino/keno-pvp/[matchId]/PageClient";
import { KENO_PVP_MATCH_UPDATED } from "../src/lib/keno-pvp/rooms";

let root = null;

const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.now();

window.__ks = {
  cues: [],
  posts: [],
  portrait: false,
  current: null,
  fetchCount: 0,
  updatedEvent: KENO_PVP_MATCH_UPDATED,
};

// ── Fake socket (the real broadcast → listener → fetchStatus path) ─────────
function makeSocket() {
  const listeners = new Map();
  const socket = {
    id: "socket-1",
    emit() {
      return true;
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
    },
    off(event, handler) {
      listeners.get(event)?.delete(handler);
    },
    timeout() {
      return socket;
    },
  };
  socket.push = (event) => {
    for (const handler of listeners.get(event) || []) handler();
  };
  return socket;
}
window.__ks.socket = makeSocket();

const PLAYERS = {
  p1: {
    id: "user_1",
    displayName: "Tester",
    iconKey: null,
    profileFrame: null,
    nameColor: null,
  },
  p2: {
    id: "user_2",
    displayName: "Rival",
    iconKey: null,
    profileFrame: null,
    nameColor: null,
  },
};

// A payload at the very start of a run: 3 lives each, no tiles resolved yet,
// the opening 1.6s window and tile 17 lit right now.
function baseMatch(now = Date.now()) {
  return {
    id: 5150,
    player1Id: "user_1",
    player2Id: "user_2",
    isAi: false,
    stakeAmount: 25,
    status: "round_1",
    p1Lives: 3,
    p2Lives: 3,
    p1Tiles: 0,
    p2Tiles: 0,
    claimedTotal: 0,
    liveTile: 17,
    liveTileIndex: 0,
    liveStartedAt: iso(now - 300),
    liveDeadline: iso(now + 1300),
    windowMs: 1600,
    tapGraceMs: 120,
    usedCount: 1,
    boardSize: 40,
    myClaimed: [],
    opponentClaimed: [],
    tileLog: [],
    winnerId: null,
    result: null,
    prizePaid: 0,
    houseFee: 0,
    startedAt: iso(now - 60_000),
    endedAt: null,
    createdAt: iso(now - 70_000),
    players: PLAYERS,
    viewerUserId: "user_1",
    viewerIsParticipant: true,
    viewerSeat: "player1",
    viewerIsPlayer1: true,
    viewerCanClaim: true,
    viewerCanCancel: false,
  };
}

window.__ks.match = (overrides = {}) => ({ ...baseMatch(), ...overrides });
window.__ks.set = (overrides = {}) => {
  window.__ks.current = window.__ks.match(overrides);
};
window.__ks.at = (offsetMs = 0) => iso(Date.now() + offsetMs);
window.__ks.set({});

// ── The scripted server: light the next tile, or refuse the tap ────────────
function nextTile(prev) {
  let candidate = null;
  for (let i = 0; i < 40; i += 1) {
    const n = 1 + Math.floor(Math.random() * 40);
    if (n !== prev) {
      candidate = n;
      break;
    }
  }
  return candidate ?? 5;
}

function applyClaim(payload, seat, tile, now) {
  const mine = seat === "player1";
  const lives = {
    ...payload,
    ...(mine
      ? { p1Tiles: payload.p1Tiles + 1, p2Lives: Math.max(0, payload.p2Lives - 1) }
      : { p2Tiles: payload.p2Tiles + 1, p1Lives: Math.max(0, payload.p1Lives - 1) }),
  };
  const entry = {
    tile,
    index: payload.liveTileIndex,
    outcome: seat,
    at: iso(now),
    p1Lives: lives.p1Lives,
    p2Lives: lives.p2Lives,
    windowMs: payload.windowMs,
    reactionMs: 240,
  };
  const eliminated =
    (seat === "player1" && lives.p2Lives === 0) ||
    (seat === "player2" && lives.p1Lives === 0);
  if (eliminated) {
    const result = seat === "player1" ? "player1" : "player2";
    return {
      ...lives,
      status: "finished",
      result,
      winnerId: seat === "player1" ? "user_1" : "user_2",
      prizePaid: 47.5,
      liveTile: null,
      liveTileIndex: payload.liveTileIndex + 1,
      liveDeadline: null,
      viewerCanClaim: false,
      myClaimed: seat === "player1" ? [...payload.myClaimed, tile] : payload.myClaimed,
      opponentClaimed: seat === "player2" ? [...payload.opponentClaimed, tile] : payload.opponentClaimed,
      tileLog: [...payload.tileLog, entry],
      endedAt: iso(now),
    };
  }
  return {
    ...lives,
    claimedTotal: payload.claimedTotal + 1,
    windowMs: Math.max(400, payload.windowMs - 100),
    liveTile: nextTile(tile),
    liveTileIndex: payload.liveTileIndex + 1,
    liveStartedAt: iso(now),
    liveDeadline: iso(now + Math.max(400, payload.windowMs - 100)),
    myClaimed: seat === "player1" ? [...payload.myClaimed, tile] : payload.myClaimed,
    opponentClaimed: seat === "player2" ? [...payload.opponentClaimed, tile] : payload.opponentClaimed,
    tileLog: [...payload.tileLog, entry],
  };
}

// ── Fake fetch ─────────────────────────────────────────────────────────────
const realFetch = window.fetch?.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? "";
  const method = (init?.method || "GET").toUpperCase();
  window.__ks.fetchCount += 1;
  const json = (body, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => body,
  });

  if (method === "POST") {
    let body = null;
    try {
      body = JSON.parse(init?.body || "null");
    } catch {
      body = null;
    }
    const record = { url, body };
    window.__ks.posts.push(record);

    if (url.includes("/ai-turn")) {
      return json({ success: true, data: { actions: 0 } });
    }
    if (url.includes("/cancel")) {
      return json({ success: true, data: {} });
    }
    if (url.includes("/catch")) {
      const now = Date.now();
      const payload = window.__ks.current;
      const tile = Number(body?.tile);
      // The authoritative gate: only the LIVE tile, only inside the window.
      if (payload?.status !== "round_1" || tile !== Number(payload.liveTile)) {
        record.rejected = "That tile is not live";
        return json(
          { success: false, error: "That tile is not live" },
          409,
        );
      }
      const liveDeadline = payload.liveDeadline
        ? new Date(payload.liveDeadline).getTime()
        : now + 1000;
      if (now > liveDeadline + (payload.tapGraceMs || 0)) {
        record.rejected = "Too slow — the tile expired";
        return json(
          { success: false, error: "Too slow — the tile expired" },
          409,
        );
      }
      window.__ks.current = applyClaim(payload, "player1", tile, now);
      window.__ks.cues.push("claim");
      return json({
        success: true,
        data: {
          claim: { tile, seat: "player1", reactionMs: 240, windowMs: payload.windowMs },
          finished: window.__ks.current.status === "finished",
          lives: { p1: window.__ks.current.p1Lives, p2: window.__ks.current.p2Lives },
          tiles: { p1: window.__ks.current.p1Tiles, p2: window.__ks.current.p2Tiles },
        },
      });
    }
    return json({ success: true });
  }

  if (url.includes("/api/keno-pvp/match/")) {
    // A real response is a FRESH JSON document every time — hand back a copy
    // so the page sees new object identity for the same state, exactly like
    // the 5s poll / a socket re-push does.
    const now = Date.now();
    const stamp = { ...window.__ks.current, serverTime: now };
    // The harness is booted by esbuild + Chromium long after its module ran,
    // so an absolute deadline captured at module load would already be in the
    // past. A live tile is always handed out at the START of its window
    // instead — the window LENGTH still comes from the shrunk `windowMs`.
    if (stamp.status === "round_1" && stamp.liveTile != null) {
      const windowMs = Number(stamp.windowMs) || 1600;
      stamp.liveStartedAt = iso(now);
      stamp.liveDeadline = iso(now + windowMs);
    }
    return json({
      success: true,
      data: {
        serverTime: Date.now(),
        match: JSON.parse(JSON.stringify(stamp)),
        rounds: [],
      },
    });
  }
  if (realFetch) return realFetch(input, init);
  return json({ success: true });
};

// ── Test controls ──────────────────────────────────────────────────────────
window.__ks.setPortrait = (on) => {
  window.__ks.portrait = Boolean(on);
};

// Append ONE resolved tile to the public log (the opponent's claim, or a
// both-miss) and push the room event, exactly like the server broadcast.
window.__ks.pushLog = (entry, overrides = {}) => {
  const payload = window.__ks.current;
  const next = {
    ...payload,
    ...overrides,
    claimedTotal: payload.claimedTotal + 1,
    windowMs: Math.max(400, payload.windowMs - 100),
    liveTileIndex: payload.liveTileIndex + 1,
    liveTile: nextTile(payload.liveTile),
    liveStartedAt: iso(Date.now()),
    liveDeadline: iso(Date.now() + Math.max(400, payload.windowMs - 100)),
    tileLog: [...payload.tileLog, { index: payload.liveTileIndex, ...entry }],
  };
  window.__ks.current = next;
  window.__ks.socket.push(KENO_PVP_MATCH_UPDATED);
};

window.__ks.redeliver = () => {
  window.__ks.socket.push(KENO_PVP_MATCH_UPDATED);
};

window.__ks.mount = () => {
  if (!root) root = createRoot(document.getElementById("root"));
  root.render(
    <KenoPvpMatchPage params={Promise.resolve({ matchId: "5150" })} />,
  );
};

window.__ks.unmount = () => {
  if (root) root.unmount();
  root = null;
  document.getElementById("root").innerHTML = "";
};
