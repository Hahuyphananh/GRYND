// qa/precision-flow-harness.jsx
//
// Integration harness for the Precision MATCH PAGE FLOW (not layout). It mounts
// the REAL `src/app/casino/precision/game/[matchId]/PageClient.tsx` with the
// heavy sibling components replaced by tiny stand-ins, and drives it with a
// scripted match state so the round lifecycle can be observed deterministically
// in a headless browser:
//
//   ready_up → click Ready → arming → active → STOP → arming (decided) → active
//
// The things it exposes for assertions:
//   * whether PageClient mounted the per-round result panel (`reveal`),
//   * what the rocket board was told (`target` / `elapsed` / `phase`),
//   * the STOP button state.
//
// `window.__precision` holds the script; `fetch` is stubbed to always answer
// `/api/precision/get-match` with the CURRENT scripted state, so advancing the
// script and waiting one poll tick is enough to drive the page.

import React from "react";
import { createRoot } from "react-dom/client";
import PrecisionMatchPage from "../src/app/casino/precision/game/[matchId]/PageClient";

let root = null;

// ── Scripted server state ───────────────────────────────────────────────────
window.__precision = {
  current: null,
  readyResponse: null,
  fetchLog: [],
};

window.__precision.set = (state) => {
  window.__precision.current = state;
  return state;
};

const baseMatch = (overrides) => ({
  matchId: "ai-test-1",
  phase: "ready_up",
  wager: 0,
  isAiGame: true,
  aiStop: null,
  players: [
    { seat: 1, userId: "human", name: "You", isReady: false, isConnected: true },
    { seat: 2, userId: "AI_BOT", name: "GRYND AI", isReady: true, isConnected: true },
  ],
  turn: 1,
  score: { seat1: 0, seat2: 0 },
  currentRound: 1,
  roundSequence: 0,
  roundId: null,
  roundNonce: null,
  targetMs: null,
  winnerSeat: null,
  lastRoundWinnerSeat: null,
  lastRoundTargetMs: null,
  armingStartedAt: null,
  countdownEndsAt: null,
  roundGoInstant: null,
  lastRoundStops: null,
  version: 1,
  ...overrides,
});

window.__precision.baseMatch = baseMatch;

window.__precision.setReadyResponse = (state) => {
  window.__precision.readyResponse = state;
};

// ── Fake fetch ──────────────────────────────────────────────────────────────
const realFetch = window.fetch?.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? "";
  window.__precision.fetchLog.push(url);
  const json = (body) => ({
    ok: true,
    status: 200,
    json: async () => body,
  });
  if (url.includes("/api/precision/get-match")) {
    return json({ success: true, match: window.__precision.current });
  }
  if (url.includes("/api/precision/ready")) {
    return json({
      success: true,
      match: window.__precision.readyResponse,
      playerReady: true,
      bothReady: true,
    });
  }
  if (url.includes("/api/precision/finish-match")) {
    return json({ success: true, payout: 0, newBalance: 0 });
  }
  if (realFetch) return realFetch(input, init);
  return json({ success: true });
};

// ── Fake socket ─────────────────────────────────────────────────────────────
function makeSocket() {
  const listeners = new Map();
  const socket = {
    id: "socket-1",
    emit(event, payload, ack) {
      // The realtime server ACKs a stop immediately; the round state still
      // arrives via polling, exactly like production.
      //
      // `emitStop` calls `socket.timeout(…).emit(event, packet, cb)`, and
      // Socket.IO delivers that callback as `(err, ack)` — `err` is null on a
      // healthy ACK. Calling the callback with the ack payload in the FIRST
      // slot made every stop look like an ACK timeout, which silently pushed
      // the check down the HTTPS-fallback path (and would hide a real
      // "stop accepted" from the page).
      if (event === "precision:stop" && typeof ack === "function") {
        setTimeout(() => ack(null, { success: true }), 0);
      }
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
  return socket;
}

window.__precision.socket = makeSocket();

window.__precision.mount = () => {
  if (!root) root = createRoot(document.getElementById("root"));
  root.render(
    <PrecisionMatchPage params={Promise.resolve({ matchId: "ai-test-1" })} />,
  );
};

// Tear the page down and clear the host so a fresh mount (the "client reloaded
// into an already-decided round" case) starts from a blank root.
window.__precision.unmount = () => {
  if (root) root.unmount();
  root = null;
  document.getElementById("root").innerHTML = "";
};
