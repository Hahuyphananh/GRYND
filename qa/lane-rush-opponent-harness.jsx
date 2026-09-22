// qa/lane-rush-opponent-harness.jsx
//
// Integration harness for the Lane Rush Duel SHARED BRIDGE match UI. It mounts
// the REAL `src/app/casino/lane-runner/[matchId]/PageClient.jsx` (only the
// noisy siblings are stubbed by qa/lane-rush-opponent-check.mjs: Clerk, the
// socket, the router, analytics, nav/footer, the waiting takeover and the
// creator-mode HOST — the creator-mode LAYOUT stays real, so the portrait
// frame under test is the shipped one) and feeds it a scripted bridge match
// through a stubbed `fetch`, exactly like the GET route's viewer payload.
//
// Everything the check needs is on `window.__lr`:
//   * `match(overrides)`  — the payload the route would return for the viewer
//                           (same field names; the bridge is the CLIENT VIEW:
//                           geometry + already-broken tiles + commitment only)
//   * `set(overrides)`    — install a payload WITHOUT announcing it (used once,
//                           before mounting, to control the load baseline)
//   * `pushAction(a, o)`  — append ONE authoritative action and push the room's
//                           update event (the same path the real broadcast +
//                           poll use), with optional state overrides
//   * `redeliver(n)`      — re-send the CURRENT payload n times (the
//                           "poll/socket repeats a snapshot" case)
//   * `posts`             — every action POST body the page sent, in order
//   * `cues`              — every gameAudio call the page made, in order
//   * `setPortrait(bool)` — flip the creator-mode dimensions to 9:16
//   * `mount()` / `unmount()`

import React from "react";
import { createRoot } from "react-dom/client";
import LaneRushDuelMatchPage from "../src/app/casino/lane-runner/[matchId]/PageClient";
import { LANE_RUSH_DUEL_MATCH_UPDATED } from "../src/lib/lane-rush-duel/rooms";

let root = null;

const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.now();

window.__lr = {
  cues: [],
  posts: [],
  portrait: false,
  current: null,
  fetchCount: 0,
  updatedEvent: LANE_RUSH_DUEL_MATCH_UPDATED,
  errors: [],
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
  // Simulate the server's room broadcast.
  socket.push = (event) => {
    for (const handler of listeners.get(event) || []) handler();
  };
  return socket;
}
window.__lr.socket = makeSocket();

// ── Scripted server state ──────────────────────────────────────────────────
// A bridge match already in progress when the view mounts, with a short
// authoritative history so "history is the baseline" can be asserted:
//   row 0  you survived tile 1;  row 1 you fell on tile 2 (broken)
//   row 2  you survived tile 0   → myRow = 3, standing before row 4
//   the opponent survived row 0 tile 1 → oppRow = 1
const BASE_ACTIONS = [
  { action: "jump", seat: "player1", userId: "user_1", row: 0, tile: 1, outcome: "safe", at: iso(T0 - 60_000) },
  { action: "jump", seat: "player1", userId: "user_1", row: 1, tile: 2, outcome: "fell", at: iso(T0 - 55_000) },
  { action: "jump", seat: "player1", userId: "user_1", row: 0, tile: 1, outcome: "safe", at: iso(T0 - 50_000) },
  { action: "jump", seat: "player1", userId: "user_1", row: 1, tile: 0, outcome: "safe", at: iso(T0 - 45_000) },
  { action: "jump", seat: "player1", userId: "user_1", row: 2, tile: 0, outcome: "safe", at: iso(T0 - 40_000) },
  { action: "jump", seat: "player2", userId: "user_2", row: 0, tile: 1, outcome: "safe", at: iso(T0 - 35_000) },
];

const BASE_BROKEN = [{ row: 1, tile: 2 }];

window.__lr.match = (overrides = {}) => ({
  id: 4242,
  player1Id: "user_1",
  player2Id: "user_2",
  player1Name: "Tester",
  player1IconKey: null,
  player1NameColor: null,
  player1ProfileFrame: null,
  player2Name: "Rival",
  player2IconKey: null,
  player2NameColor: null,
  player2ProfileFrame: null,
  stakeAmount: 25,
  difficulty: "medium",
  status: "active",
  firstPlayerId: "user_1",
  currentTurnUserId: "user_1",
  // A live 15s window on the server clock (serverNow is stamped per response).
  roundDeadline: iso(T0 + 12_000),
  serverNow: iso(Date.now()),
  roundTimerSeconds: 15,
  viewerIsPlayer1: true,
  isViewerTurn: true,
  // ── Shared bridge (the redesigned game) ─────────────────────────────
  bridge: {
    rows: 10,
    tiles: 3,
    difficulty: "medium",
    commitment: "commitment-hash",
    broken: BASE_BROKEN,
    revealedRows: [1],
  },
  bridgeRows: 10,
  tileCount: 3,
  myRow: 3,
  oppRow: 1,
  broken: BASE_BROKEN.map((b) => ({ ...b })),
  myFlags: [{ row: 0, tile: 1 }],
  oppFlags: [{ row: 2, tile: 1 }],
  myFlagsLeft: 1,
  oppFlagsLeft: 1,
  flagsPerPlayer: 2,
  actions: BASE_ACTIONS.map((a) => ({ ...a })),
  serverSeed: null,
  serverSeedHash: "seed-hash",
  p1ClientSeed: "client-seed-1",
  p2ClientSeed: null,
  result: null,
  winnerId: null,
  prizePaid: 0,
  houseFee: 0,
  startedAt: iso(T0 - 90_000),
  endedAt: null,
  createdAt: iso(T0 - 120_000),
  ...overrides,
});

// Set the payload WITHOUT announcing it (used once, before mounting).
window.__lr.set = (overrides = {}) => {
  window.__lr.current = window.__lr.match(overrides);
  return window.__lr.current;
};

// Append ONE authoritative action and announce it exactly the way the server
// does (room broadcast → the page refetches). The page never invents it.
window.__lr.pushAction = (action, overrides = {}) => {
  const actions = [...(window.__lr.current?.actions || BASE_ACTIONS), action];
  window.__lr.current = window.__lr.match({ ...overrides, actions });
  window.__lr.socket.push(window.__lr.updatedEvent);
  return window.__lr.current;
};

// Re-deliver the SAME payload n times — the "a poll/socket snapshot repeats
// a state" case that must never restart anything on the board.
window.__lr.redeliver = (n = 1) => {
  for (let i = 0; i < n; i += 1) {
    window.__lr.socket.push(window.__lr.updatedEvent);
  }
  return window.__lr.current;
};

window.__lr.at = (offsetMs = 0) => iso(Date.now() + offsetMs);

// Every wake-up the page has sent to the practice bot, in order. The stub
// answers each one with `success` WITHOUT applying an action, which is exactly
// the throttled no-op the page has to retry through.
window.__lr.aiAsks = () =>
  (window.__lr.posts || []).filter((p) => p.url.includes("/ai-turn"));

// ── Fake fetch ─────────────────────────────────────────────────────────────
const realFetch = window.fetch?.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? "";
  const method = (init?.method || "GET").toUpperCase();
  window.__lr.fetchCount += 1;
  const json = (body) => ({ ok: true, status: 200, json: async () => body });

  // An action POST (or the bot wake-up) — record the body for assertions.
  if (
    method === "POST" &&
    (url.includes("/act") || url.includes("/ai-turn"))
  ) {
    let body = null;
    try {
      body = JSON.parse(init?.body || "null");
    } catch {
      body = null;
    }
    window.__lr.posts.push({ url, body });
    return json({ success: true, data: { status: "active", duplicate: false, result: null, winnerId: null } });
  }

  if (url.includes("/api/lane-rush-duel/match/")) {
    // A real response body is a FRESH JSON document every time, so hand back
    // a copy: the page receives new object identity for the same state, which
    // is exactly what the 5s poll and a socket re-push do.
    const stamp = { ...window.__lr.current, serverNow: iso(Date.now()) };
    return json({ success: true, data: { match: JSON.parse(JSON.stringify(stamp)) } });
  }
  if (realFetch) return realFetch(input, init);
  return json({ success: true });
};

// ── Mount / unmount ────────────────────────────────────────────────────────
window.__lr.setPortrait = (on) => {
  window.__lr.portrait = Boolean(on);
};

window.__lr.mount = () => {
  if (!root) root = createRoot(document.getElementById("root"));
  root.render(
    <LaneRushDuelMatchPage params={Promise.resolve({ matchId: "4242" })} />,
  );
};

window.__lr.unmount = () => {
  if (root) root.unmount();
  root = null;
  document.getElementById("root").innerHTML = "";
};
