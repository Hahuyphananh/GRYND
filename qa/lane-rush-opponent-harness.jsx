// qa/lane-rush-opponent-harness.jsx
//
// Integration harness for the Lane Rush duel's OPPONENT feedback. It mounts
// the REAL `src/app/casino/lane-runner/[matchId]/PageClient.jsx` (only the
// noisy siblings are stubbed by qa/lane-rush-opponent-check.mjs: Clerk, the
// socket, the router, analytics, nav/footer, the waiting takeover, and the
// creator-mode HOST — the creator-mode LAYOUT stays real, so the portrait
// frame under test is the shipped one) and feeds it a scripted bot match
// through a stubbed `fetch`, exactly like the GET route's viewer payload.
//
// Everything the check needs is on `window.__lr`:
//   * `match(overrides)`  — the payload the route would return for the viewer
//                           (same field names; an opponent peek carries no
//                           path/tile/answer, exactly like the server's scrub)
//   * `pushAction(a, o)`  — append ONE authoritative opponent action and push
//                           the room's update event (the same path the real
//                           broadcast + poll use), so the page advances
//   * `redeliver(n)`      — re-send the CURRENT payload n times (the
//                           "poll/socket repeats an action" case)
//   * `cues`              — every gameAudio call the page made, in order
//                           (audio is stubbed with spies, so "which cue fired
//                           and how often" is assertable without Web Audio)
//   * `setPortrait(bool)` — flip the creator-mode dimensions to 9:16

import React from "react";
import { createRoot } from "react-dom/client";
import LaneRushDuelMatchPage from "../src/app/casino/lane-runner/[matchId]/PageClient";
import { LANE_RUSH_DUEL_MATCH_UPDATED } from "../src/lib/lane-rush-duel/rooms";

let root = null;

const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.now();

window.__lr = {
  cues: [],
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
// A bot match already in progress when the view mounts (so the load baseline
// — "history is never news" — can be asserted), with:
//   row 0  you: balanced tile 0 survived  |  bot: balanced tile 1 survived
//          → same path, so the bot's pick must show as a dashed TILE marker
//   row 1  bot: risky tile 0 survived     → different path from the balanced
//          row you are standing on, so it must show as a BADGE
const BASE_ACTIONS = [
  {
    action: "pick",
    seat: "player1",
    userId: "user_1",
    path: "balanced",
    tile: 0,
    round: 0,
    lane: 0,
    safe: true,
    points: 10,
    at: iso(T0 - 60_000),
  },
  {
    action: "pick",
    seat: "player2",
    userId: "AI_BOT",
    path: "balanced",
    tile: 1,
    round: 0,
    lane: 0,
    safe: true,
    points: 16,
    at: iso(T0 - 55_000),
  },
  {
    action: "pick",
    seat: "player2",
    userId: "AI_BOT",
    path: "risky",
    tile: 0,
    round: 1,
    lane: 1,
    safe: true,
    points: 25,
    at: iso(T0 - 50_000),
  },
];

window.__lr.match = (overrides = {}) => ({
  id: 4242,
  player1Id: "user_1",
  player2Id: "AI_BOT",
  player1Name: "Tester",
  player1IconKey: null,
  player1NameColor: null,
  player2Name: null,
  player2IconKey: null,
  player2NameColor: null,
  stakeAmount: 25,
  difficulty: "easy",
  tilesPerLane: 4,
  status: "active",
  firstPlayerId: "user_1",
  currentTurnUserId: null,
  roundDeadline: null,
  roundTimerSeconds: null,
  viewerIsPlayer1: true,
  isViewerTurn: false,
  myPending: false,
  oppPending: false,
  // Viewer seat (player1) — standing on row 1 with 10 points banked nowhere.
  myLane: 1,
  myHeld: false,
  myScore: 10,
  myBanked: 0,
  myBanks: 0,
  myRate: 1,
  myEnded: false,
  // Bot seat (player2) — ahead on row 2 with 41 accumulated.
  oppLane: 2,
  oppHeld: false,
  oppScore: 41,
  oppBanked: 0,
  oppBanks: 0,
  oppRate: 1,
  oppEnded: false,
  actions: BASE_ACTIONS.map((a) => ({ ...a })),
  myTower: null,
  oppTower: null,
  p1Points: 0,
  p2Points: 0,
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
// an action" case that must never replay any feedback.
window.__lr.redeliver = (n = 1) => {
  for (let i = 0; i < n; i += 1) {
    window.__lr.socket.push(window.__lr.updatedEvent);
  }
  return window.__lr.current;
};

window.__lr.at = (offsetMs = 0) => iso(Date.now() + offsetMs);

// ── Fake fetch ─────────────────────────────────────────────────────────────
const realFetch = window.fetch?.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? "";
  window.__lr.fetchCount += 1;
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  if (url.includes("/api/lane-rush-duel/match/")) {
    // A real response body is a FRESH JSON document every time, so hand back
    // a copy: the page receives new object identity for the same state, which
    // is exactly what the 5s poll and a socket re-push do — and exactly the
    // case the feedback dedup has to survive.
    return json({
      success: true,
      data: { match: JSON.parse(JSON.stringify(window.__lr.current)) },
    });
  }
  if (url.includes("/api/user/stats") || url.includes("/api/leaderboard")) {
    return json({ success: false });
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
    <LaneRushDuelMatchPage
      params={Promise.resolve({ matchId: "4242" })}
    />,
  );
};

window.__lr.unmount = () => {
  if (root) root.unmount();
  root = null;
  document.getElementById("root").innerHTML = "";
};
