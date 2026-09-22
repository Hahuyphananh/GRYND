// qa/board-fit-harness.jsx
//
// Integration harness for the DESKTOP BOARD FIT of the two grid games:
//   • Mines Duel   — src/app/casino/mines-pvp/[matchId]/PageClient.tsx
//   • Memory Grid  — src/app/casino/memory-grid/[matchId]/PageClient.tsx
//
// qa/board-fit-check.mjs bundles this file (stubbing Clerk, the socket, the
// router, analytics, nav/footer, the waiting takeover and the creator-mode
// HOST — the creator-mode LAYOUT stays real, so the exemption under test is
// the shipped one) and mounts the REAL page against a scripted match through a
// stubbed `fetch`. Both boards are squares, so the whole point of the check is
// measurable in the browser: the board's painted box must end ABOVE the
// viewport bottom, i.e. no scrolling is needed to see all 25 tiles / the whole
// grid.
//
// Everything the check needs lives on `window.__bf`:
//   * `set(page, overrides)` — install a payload WITHOUT announcing it
//   * `mount(page)`          — render the page (mines | memory)
//   * `unmount()`
//   * `setCreator(bool)`     — flip creator mode on/off (real <CreatorView>)
//   * `measure(selector)`    — the painted box + viewport metrics
//   * `posts` / `fetchCount` — what the page sent / asked

import React from "react";
import { createRoot } from "react-dom/client";
import MinesDuelMatchPage from "../src/app/casino/mines-pvp/[matchId]/PageClient";
import MemoryGridMatchPage from "../src/app/casino/memory-grid/[matchId]/PageClient";
import { MINES_PVP_MATCH_UPDATED } from "../src/lib/mines-pvp/rooms";
import { MEMORY_GRID_MATCH_UPDATED } from "../src/lib/memory-grid/rooms";

let root = null;

const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.now();

window.__bf = {
  page: null,
  current: null,
  posts: [],
  fetchCount: 0,
  creator: false,
  minesUpdatedEvent: MINES_PVP_MATCH_UPDATED,
  memoryUpdatedEvent: MEMORY_GRID_MATCH_UPDATED,
};

// ── Fake socket (the real broadcast → listener → refetch path) ─────────────
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
window.__bf.socket = makeSocket();

// ═══════════════════════════════════════════════════════════════════════════
// MINES DUEL — a live 5×5 match, my turn, a couple of picks already revealed
// ═══════════════════════════════════════════════════════════════════════════
const MINE_PICKS = [
  { userId: "user_1", seat: "player1", cell: 7, isMine: false, hint: 2, autoPicked: false, pickedAt: iso(T0 - 40_000) },
  { userId: "user_2", seat: "player2", cell: 12, isMine: false, hint: 1, autoPicked: false, pickedAt: iso(T0 - 30_000) },
  { userId: "user_1", seat: "player1", cell: 8, isMine: false, hint: 1, autoPicked: false, pickedAt: iso(T0 - 20_000) },
];

window.__bf.minesMatch = (overrides = {}) => ({
  id: 4242,
  player1Id: "user_1",
  player2Id: "user_2",
  isAi: false,
  stakeAmount: "25",
  status: "p1_turn",
  minesCount: 5,
  safeTilesRemaining: 14,
  board: null,
  firstPlayerId: "user_1",
  currentTurnUserId: "user_1",
  picks: MINE_PICKS.map((p) => ({ ...p })),
  pickCount: MINE_PICKS.length,
  p1Pick: 8,
  p2Pick: 12,
  p1PickIsMine: false,
  p2PickIsMine: false,
  p1AutoPicked: false,
  p2AutoPicked: false,
  p1PickedAt: iso(T0 - 20_000),
  p2PickedAt: iso(T0 - 30_000),
  roundDeadline: iso(T0 + 14_000),
  roundTimerSeconds: 20,
  winnerId: null,
  result: null,
  houseFee: "0",
  prizePaid: "0",
  startedAt: iso(T0 - 60_000),
  endedAt: null,
  createdAt: iso(T0 - 80_000),
  players: {
    p1: { id: "user_1", displayName: "Tester", iconKey: "cat", profileFrame: null, nameColor: null },
    p2: { id: "user_2", displayName: "Rival", iconKey: "ghost", profileFrame: null, nameColor: null },
  },
  ...overrides,
});

// ═══════════════════════════════════════════════════════════════════════════
// MEMORY GRID — round 2, reconstruct phase, my turn to pick
// ═══════════════════════════════════════════════════════════════════════════
window.__bf.memoryMatch = (overrides = {}) => ({
  id: 5150,
  player1Id: "user_1",
  player2Id: "user_2",
  isAi: false,
  stakeAmount: 25,
  status: "p1_turn",
  phase: "reconstruct",
  roundNumber: 2,
  roundsPerMatch: 5,
  roundConfig: { gridSize: 5, activeCount: 7, memorizeMs: 5000 },
  viewerIsPlayer1: true,
  p1Submitted: false,
  p2Submitted: false,
  phaseStartedAt: iso(T0 - 5_000),
  phaseDeadline: iso(T0 + 20_000),
  serverNow: iso(T0),
  p1Score: 1,
  p2Score: 0,
  p1Total: 180,
  p2Total: 140,
  p1RoundScore: 0,
  p2RoundScore: 0,
  players: {
    p1: { id: "user_1", displayName: "Tester", iconKey: "cat", profileFrame: null },
    p2: { id: "user_2", displayName: "Rival", iconKey: "ghost", profileFrame: null },
  },
  pattern: { size: 5, total: 25, active: [0, 3, 6, 11, 14, 19, 22] },
  result: null,
  winnerId: null,
  prizePaid: 0,
  houseFee: 0,
  refundEach: null,
  startedAt: iso(T0 - 120_000),
  endedAt: null,
  createdAt: iso(T0 - 140_000),
  ...overrides,
});

window.__bf.match = (page, overrides = {}) =>
  page === "memory" ? window.__bf.memoryMatch(overrides) : window.__bf.minesMatch(overrides);

// Install a payload WITHOUT announcing it (used once, before mounting).
window.__bf.set = (page, overrides = {}) => {
  window.__bf.page = page;
  window.__bf.current = window.__bf.match(page, overrides);
  return window.__bf.current;
};

// ── Fake fetch ─────────────────────────────────────────────────────────────
const realFetch = window.fetch?.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? "";
  const method = (init?.method || "GET").toUpperCase();
  window.__bf.fetchCount += 1;
  const json = (body) => ({ ok: true, status: 200, json: async () => body });

  if (method === "POST") {
    let body = null;
    try {
      body = JSON.parse(init?.body || "null");
    } catch {
      body = null;
    }
    window.__bf.posts.push({ url, body });
    // Every action/flag/ai-turn route: acknowledge without mutating state, so
    // the board's painted geometry is driven purely by the scripted payload.
    return json({ success: true, data: { status: "active", duplicate: false, result: null } });
  }

  const isMatch = url.includes("/api/mines-pvp/match/") || url.includes("/api/memory-grid/match/");
  if (isMatch) {
    // A real response is a FRESH JSON document every time — hand back a copy.
    const stamp =
      window.__bf.page === "memory" && url.includes("memory-grid")
        ? { ...window.__bf.current, serverNow: iso(Date.now()) }
        : { ...window.__bf.current, serverNow: iso(Date.now()) };
    return json({ success: true, data: { match: JSON.parse(JSON.stringify(stamp)), roundHistory: [] } });
  }
  if (realFetch) return realFetch(input, init);
  return json({ success: true });
};

// ── Mount / unmount ────────────────────────────────────────────────────────
window.__bf.setCreator = (on) => {
  window.__bf.creator = Boolean(on);
};

window.__bf.mount = (page) => {
  window.__bf.page = page;
  const host = document.getElementById("root");
  if (!root) root = createRoot(host);
  root.render(
    page === "memory" ? (
      <MemoryGridMatchPage params={Promise.resolve({ matchId: "5150" })} />
    ) : (
      <MinesDuelMatchPage params={Promise.resolve({ matchId: "4242" })} />
    ),
  );
};

window.__bf.unmount = () => {
  if (root) root.unmount();
  root = null;
  document.getElementById("root").innerHTML = "";
};

// ── The measurement the check is actually about ────────────────────────────
// `offsetWithin` walks up the offsetParent chain, so it reports the element's
// LAYOUT box — immune to the board's entrance spring and to a creator `zoom`.
window.__bf.measure = (selector) => {
  const el = document.querySelector(selector);
  if (!el) return null;
  let x = 0;
  let y = 0;
  let node = el;
  while (node instanceof HTMLElement) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent;
  }
  return {
    selector,
    top: y,
    left: x,
    width: el.offsetWidth,
    height: el.offsetHeight,
    bottom: y + el.offsetHeight,
    right: x + el.offsetWidth,
    viewportHeight: window.innerHeight,
    viewportWidth: window.innerWidth,
    documentHeight: document.documentElement.scrollHeight,
    scrollY: window.scrollY,
    canScrollY: document.documentElement.scrollHeight > window.innerHeight + 1,
  };
};
