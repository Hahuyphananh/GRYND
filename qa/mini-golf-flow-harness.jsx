// qa/mini-golf-flow-harness.jsx
//
// Integration harness for the Mini Golf MATCH page
// (src/app/casino/mini-golf/[matchId]/PageClient.tsx).
//
// qa/mini-golf-flow-check.mjs bundles this file (stubbing Clerk, the socket, the
// router, analytics, the session host, the waiting takeover, the result screen
// and the emote picker) and mounts the REAL page against a real, deterministic
// authoritative server implemented here — the SAME course generator the backend
// ships (`generateCourse`), and the SAME shot rules the pure engine applies
// (`mini-golf` per-seat balls; a hole completes only when BOTH balls are in the
// cup; the first seat to 3 hole wins takes the match).
//
// The point of the harness is to prove the CLIENT contract the prompt is about:
//   * the only thing it ever sends is { angle, power } (+ expectedVersion)
//   * it plays the SERVER'S `lastShot.result.path`, never a local simulation
//   * it adopts the authoritative balls / strokes / hole winners / result
//   * the aim preview is drawn but is not treated as truth
//   * both seats can be pointed at the same authoritative state and see the
//     same course, the same balls and the same score.
//
// Everything the check drives lives on `window.__bf`:
//   * `mount()` / `unmount()`            — render the real match page
//   * `socket`                           — fake socket; `push(event)` fans out
//   * `posts`                            — every POST the page made
//   * `server`                           — the authoritative model
//       · reset({ seed, status })        — deal a fresh match
//       · snapshot()                     — the viewer-shaped DTO the page fetches
//       · gameState() / load(raw)        — viewer-NEUTRAL state, for cross-page sync
//       · shoot({ pocketed })            — the viewer's shot (the POST handler)
//       · simulateShot({ seat, pocketed }) — inject ANY seat's shot (opponent)
//       · setViewer("player1"|"player2") — which seat this page is playing
//   * `ballClientPos(seat)`              — where a seat's ball is on screen
//   * `errors`                           — runtime errors seen by the page

import React from "react";
import { createRoot } from "react-dom/client";
import MiniGolfMatchPage from "../src/app/casino/mini-golf/[matchId]/PageClient";
import { generateCourse } from "../src/lib/mini-golf/courseGenerator";
import { MINI_GOLF_MATCH_UPDATED } from "../src/lib/mini-golf/rooms";
import { clampPower, courseScale, directionFromAngle } from "../src/lib/mini-golf/ui";
import { BALL_RADIUS } from "../src/lib/mini-golf/constants";

const MATCH_ID = "mglf_1";
const PLAYERS = {
  player1: { name: "Tester", iconKey: "cat", profileFrame: null },
  player2: { name: "Rival", iconKey: "ghost", profileFrame: null },
};

let root = null;
let state = null;
let viewer = "player1";
let shotPlan = [];

const copy = (value) => JSON.parse(JSON.stringify(value));
const errors = [];

// ── Fake socket (the real broadcast → listener → refetch path) ─────────────
function makeSocket() {
  const listeners = new Map();
  const socket = {
    id: "socket-1",
    emitted: [],
    emit(event, payload) {
      socket.emitted.push({ event, payload });
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
  socket.push = (event, payload) => {
    for (const handler of listeners.get(event) || []) handler(payload);
  };
  return socket;
}

window.__bf = {
  matchId: MATCH_ID,
  updatedEvent: MINI_GOLF_MATCH_UPDATED,
  socket: makeSocket(),
  posts: [],
  errors,
};

window.addEventListener("error", (e) => errors.push(String(e.message || e)));
window.addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));

// ═══════════════════════════════════════════════════════════════════════════
// The authoritative model
// ═══════════════════════════════════════════════════════════════════════════

const teeBall = (hole) => ({
  x: hole.geometry.tee.x,
  y: hole.geometry.tee.y,
  vx: 0,
  vy: 0,
  radius: BALL_RADIUS,
  moving: false,
  holedOut: false,
});

function seatBalls() {
  const hole = state.holes[state.currentHole - 1];
  state.balls = { player1: teeBall(hole), player2: teeBall(hole) };
  state.currentStroke = 0;
  state.currentTurn = "player1";
}

function reset({ seed = 20260926, status = "playing" } = {}) {
  const course = generateCourse(seed);
  state = {
    version: 1,
    status,
    seed,
    courseVersion: course.version,
    holes: copy(course.holes),
    currentHole: 1,
    currentTurn: "player1",
    balls: {},
    currentStroke: 0,
    holeScores: course.holes.map(() => ({ player1: 0, player2: 0 })),
    holeWinners: course.holes.map(() => null),
    player1HoleWins: 0,
    player2HoleWins: 0,
    shotSeq: 0,
    lastShot: null,
    result: null,
    winnerId: null,
  };
  seatBalls();
  shotPlan = [];
  return snapshot();
}

function settleTerminal() {
  const p1 = state.player1HoleWins;
  const p2 = state.player2HoleWins;
  const lastIndex = state.holes.length - 1;
  const exhausted = state.currentHole >= state.holes.length && state.holeWinners[lastIndex] != null;
  if (p1 < 3 && p2 < 3 && !exhausted) return;
  state.status = "finished";
  state.result = p1 > p2 ? "player1" : p2 > p1 ? "player2" : "tie";
  state.winnerId = state.result === "player1" ? "user_1" : state.result === "player2" ? "user_2" : null;
}

function completeHole(holeIndex) {
  const score = state.holeScores[holeIndex];
  const winner = score.player1 < score.player2 ? "player1" : score.player2 < score.player1 ? "player2" : "tie";
  state.holeWinners[holeIndex] = winner;
  if (winner === "player1") state.player1HoleWins += 1;
  if (winner === "player2") state.player2HoleWins += 1;
  if (state.currentHole < state.holes.length) {
    state.currentHole += 1;
    seatBalls();
  }
}

/**
 * Apply one authoritative shot. `pocketed` is the scripted outcome the check is
 * driving (the real engine decides it from the sim; the harness only needs to
 * be honest about the resulting state, which is what the client consumes).
 */
function applyShot(input, { pocketed = false, seat = null } = {}) {
  if (!state || state.status !== "playing") return { ok: false, error: "Match is not playing" };
  // Optimistic concurrency, exactly like the route.
  const expected = input?.expectedVersion;
  if (expected != null && Number(expected) !== state.version) {
    return { ok: false, error: "Shot rejected: stale version" };
  }
  const shooter = seat ?? state.currentTurn;
  const holeIndex = state.currentHole - 1;
  const hole = state.holes[holeIndex];
  const ball = state.balls[shooter];
  const angle = Number(input?.angle) || 0;
  const power = clampPower(Number(input?.power) || 0);
  const dir = directionFromAngle(angle);
  const travel = 24 + (power / 100) * 150;
  const rest = pocketed
    ? { x: hole.geometry.cup.x, y: hole.geometry.cup.y }
    : {
        x: Math.min(hole.geometry.width - BALL_RADIUS, Math.max(BALL_RADIUS, ball.x + dir.x * travel)),
        y: Math.min(hole.geometry.height - BALL_RADIUS, Math.max(BALL_RADIUS, ball.y + dir.y * travel)),
      };
  const path = [
    { x: ball.x, y: ball.y },
    { x: ball.x + (rest.x - ball.x) * 0.5, y: ball.y + (rest.y - ball.y) * 0.5 },
    { x: rest.x, y: rest.y },
  ];

  state.version += 1;
  state.shotSeq += 1;
  state.holeScores[holeIndex][shooter] += 1;
  ball.x = rest.x;
  ball.y = rest.y;
  if (pocketed) ball.holedOut = true;
  state.lastShot = {
    seat: shooter,
    hole: holeIndex + 1,
    strokeNumber: state.holeScores[holeIndex][shooter],
    angle,
    power,
    result: {
      path,
      restPosition: rest,
      pocketed,
      settled: true,
      frames: 60,
      substeps: 20,
      hitStepLimit: false,
      waterHits: 0,
    },
  };
  state.currentStroke = state.holeScores[holeIndex][shooter];

  if (state.balls.player1.holedOut && state.balls.player2.holedOut) {
    completeHole(holeIndex);
  } else {
    const other = shooter === "player1" ? "player2" : "player1";
    state.currentTurn = state.balls[other].holedOut ? shooter : other;
  }
  settleTerminal();
  return { ok: true };
}

/** The viewer-shaped DTO the match GET route returns. */
function snapshot() {
  if (!state) return null;
  const me = state.balls[viewer] ?? { x: 0, y: 0 };
  const isViewerTurn = state.currentTurn === viewer;
  return {
    ...copy(state),
    matchId: MATCH_ID,
    players: PLAYERS,
    player1Id: "user_1",
    player2Id: "user_2",
    viewerSeat: viewer,
    isViewerTurn,
    viewerCanShoot: state.status === "playing" && isViewerTurn && !me.holedOut,
    viewerHasHoledOut: Boolean(me.holedOut),
  };
}

window.__bf.server = {
  reset,
  snapshot,
  gameState: () => copy(state),
  load: (raw) => {
    state = copy(raw);
  },
  setViewer: (seat) => {
    viewer = seat;
  },
  getViewer: () => viewer,
  plan: (arr) => {
    shotPlan = arr.slice();
  },
  shoot: (input) => applyShot(input, shotPlan.shift() ?? {}),
  simulateShot: ({ seat, pocketed = false }) => applyShot({ angle: 90, power: 60 }, { seat, pocketed }),
  forceFinish: ({ winner = "player1" } = {}) => {
    if (!state) return;
    state.status = "finished";
    state.result = winner;
    state.winnerId = winner === "player1" ? "user_1" : winner === "player2" ? "user_2" : null;
  },
};

// ── Fake fetch ─────────────────────────────────────────────────────────────
const realFetch = window.fetch?.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? "";
  const method = (init?.method || "GET").toUpperCase();
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

  if (method === "POST") {
    let body = null;
    try {
      body = JSON.parse(init?.body || "null");
    } catch {
      body = null;
    }
    window.__bf.posts.push({ url, body });
    if (url.includes("/shoot")) {
      const result = window.__bf.server.shoot(body ?? {});
      if (!result.ok) return json({ success: false, error: result.error }, 409);
      return json({ success: true, data: { match: snapshot() } });
    }
    // forfeit / cancel / reports: acknowledge and reflect a terminal state.
    if (url.includes("/forfeit") || url.includes("/cancel")) {
      if (state) {
        state.status = url.includes("/cancel") ? "cancelled" : "finished";
        state.result = url.includes("/cancel") ? null : "player2";
        state.winnerId = url.includes("/cancel") ? null : "user_2";
      }
      return json({ success: true, data: { match: snapshot() } });
    }
    return json({ success: true, data: {} });
  }

  if (url.includes("/api/mini-golf/match/")) {
    // A real response is a FRESH document every time.
    return json({ success: true, data: snapshot() });
  }
  if (realFetch) return realFetch(input, init);
  return json({ success: true });
};

// ── Mount / unmount ────────────────────────────────────────────────────────
window.__bf.mount = () => {
  const host = document.getElementById("root");
  if (!root) root = createRoot(host);
  root.render(<MiniGolfMatchPage />);
};

window.__bf.unmount = () => {
  if (root) root.unmount();
  root = null;
  document.getElementById("root").innerHTML = "";
};

// ── Screen position of a seat's ball (for pointer drags) ───────────────────
window.__bf.ballClientPos = (seat = viewer) => {
  const canvas = document.querySelector('[data-testid="mini-golf-canvas"]');
  if (!canvas || !state) return null;
  const rect = canvas.getBoundingClientRect();
  const hole = state.holes[state.currentHole - 1];
  const render = courseScale(hole.geometry, rect.width, rect.height);
  const ball = state.balls[seat];
  return {
    x: rect.left + render.offsetX + ball.x * render.scale,
    y: rect.top + render.offsetY + ball.y * render.scale,
    scale: render.scale,
    courseWidth: rect.width,
    courseHeight: rect.height,
  };
};

// Deal the default match immediately so a mount without an explicit reset works.
reset();
