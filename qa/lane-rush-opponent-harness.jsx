// qa/lane-rush-opponent-harness.jsx
//
// Integration harness for the Lane Rush RACE match UI. It mounts the REAL
// `src/app/casino/lane-runner/[matchId]/PageClient.jsx` (only the noisy
// siblings are stubbed by qa/lane-rush-opponent-check.mjs: Clerk, the socket,
// the router, analytics, nav/footer, the waiting takeover, the practice-pause
// hook and the result screen shell) and feeds it a scripted RACE match through
// a stubbed `fetch`, exactly like the GET route's viewer payload.
//
// Everything the check needs is on `window.__lr`:
//   * `match(overrides)`  — the payload the route would return for the viewer
//   * `set(overrides)`    — install a payload WITHOUT announcing it
//   * `pushAction(a, o)`  — append ONE authoritative planning action and push
//                           the room's update event
//   * `pushRound(round, o)` — append a RESOLVED round (scores + lastResult) and
//                           announce it, the same path the real resolver uses
//   * `redeliver(n)`      — re-send the CURRENT payload n times
//   * `posts`             — every action POST body the page sent, in order
//   * `cues`              — every gameAudio call the page made, in order
//   * `mount()` / `unmount()`

import React from "react";
import { createRoot } from "react-dom/client";
import LaneRushMatchPage from "../src/app/casino/lane-runner/[matchId]/PageClient";
import { LANE_RUSH_DUEL_MATCH_UPDATED } from "../src/lib/lane-rush-duel/rooms";

let root = null;

const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.now();

window.__lr = {
  cues: [],
  posts: [],
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
  socket.push = (event) => {
    for (const handler of listeners.get(event) || []) handler();
  };
  return socket;
}
window.__lr.socket = makeSocket();

// ── Scripted server state ──────────────────────────────────────────────────
const garageCar = (id, tier = 1, overrides = {}) => ({
  id,
  owner: "player1",
  tier,
  status: "garage",
  damaged: false,
  route: null,
  upgrades: [],
  ...overrides,
});

// Round 1 is already resolved when the view mounts, so "history is the
// baseline" (a reconnect must not replay it) is testable from the first paint.
const ROUND_1 = {
  round: 1,
  resolvedAt: iso(T0 - 40_000),
  cars: [
    {
      seat: "player1",
      carId: "p1-c1",
      tier: 1,
      route: "sprint",
      roll: 0.62,
      outcome: "finished",
      points: 18,
      reward: { resource: "fuel", amount: 1 },
    },
    {
      seat: "player2",
      carId: "p2-c1",
      tier: 1,
      route: "safe",
      roll: 0.11,
      outcome: "dnf",
      points: 0,
      reward: null,
    },
  ],
  points: { player1: 18, player2: 0 },
  totals: { player1: 18, player2: 0 },
};

const BASE_MY_CARS = [
  garageCar("p1-c1"),
  garageCar("p1-c2"),
  garageCar("p1-c3", 2, { damaged: true }),
];

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
  lifecycle: "planning",
  mode: "race",
  gameStateVersion: 1,
  phase: "planning",
  round: 2,
  planningDeadline: iso(Date.now() + 45_000),
  serverNow: iso(Date.now()),
  roundTimerSeconds: 60,
  viewerIsPlayer1: true,
  mySeat: "player1",
  canAct: true,
  locked: false,
  oppLocked: false,
  actionPoints: 2,
  myPoints: 18,
  oppPoints: 0,
  myResources: { scrap: 4, fuel: 1, tech: 0 },
  myCars: BASE_MY_CARS.map((car) => ({ ...car })),
  oppCars: [
    garageCar("p2-c1", 1, { owner: "player2" }),
    garageCar("p2-c2", 2, { owner: "player2", route: null }),
  ],
  myActions: [],
  results: [ROUND_1],
  lastResult: ROUND_1,
  result: null,
  winnerId: null,
  winnerSeat: null,
  prizePaid: 0,
  houseFee: 0,
  startedAt: iso(T0 - 90_000),
  endedAt: null,
  createdAt: iso(T0 - 120_000),
  ...overrides,
});

window.__lr.set = (overrides = {}) => {
  window.__lr.current = window.__lr.match(overrides);
  return window.__lr.current;
};

window.__lr.pushAction = (action, overrides = {}) => {
  const actions = [...(window.__lr.current?.myActions || []), action];
  window.__lr.current = window.__lr.match({
    ...(window.__lr.current || {}),
    ...overrides,
    myActions: actions,
  });
  window.__lr.socket.push(window.__lr.updatedEvent);
  return window.__lr.current;
};

window.__lr.pushRound = (round, overrides = {}) => {
  const previous = window.__lr.current || window.__lr.match();
  const results = [...(previous.results || []), round];
  window.__lr.current = window.__lr.match({
    ...previous,
    ...overrides,
    round: round.round + 1,
    results,
    lastResult: round,
    myPoints: round.totals.player1,
    oppPoints: round.totals.player2,
    planningDeadline: iso(Date.now() + 45_000),
    locked: false,
    oppLocked: false,
    actionPoints: 2,
    myActions: [],
  });
  window.__lr.socket.push(window.__lr.updatedEvent);
  return window.__lr.current;
};

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
  const method = (init?.method || "GET").toUpperCase();
  window.__lr.fetchCount += 1;
  const json = (body) => ({ ok: true, status: 200, json: async () => body });

  if (method === "POST" && url.includes("/act")) {
    let body = null;
    try {
      body = JSON.parse(init?.body || "null");
    } catch {
      body = null;
    }
    window.__lr.posts.push({ url, body });
    return json({ success: true, data: { status: "active", duplicate: false } });
  }

  if (url.includes("/api/lane-rush-duel/match/")) {
    const stamp = { ...window.__lr.current, serverNow: iso(Date.now()) };
    return json({ success: true, data: { match: JSON.parse(JSON.stringify(stamp)) } });
  }
  if (realFetch) return realFetch(input, init);
  return json({ success: true });
};

// ── Mount / unmount ────────────────────────────────────────────────────────
window.__lr.mount = () => {
  if (!root) root = createRoot(document.getElementById("root"));
  root.render(
    <LaneRushMatchPage params={Promise.resolve({ matchId: "4242" })} />,
  );
};

window.__lr.unmount = () => {
  if (root) root.unmount();
  root = null;
  document.getElementById("root").innerHTML = "";
};
