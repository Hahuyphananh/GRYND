// Temporary reproduction harness (deleted after the investigation).
// Mounts the REAL Precision match page with the REAL round-result panel,
// scoreboard and rocket race, and reports every value the player can read
// back for each seat after a round is decided.

import React from "react";
import { createRoot } from "react-dom/client";
import PrecisionMatchPage from "../src/app/casino/precision/game/[matchId]/PageClient";

let root = null;

window.__precision = { current: null, readyResponse: null, posts: [] };

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
    { seat: 1, userId: "human", name: "You", isReady: true, isConnected: true },
    { seat: 2, userId: "AI_BOT", name: "GRYND AI", isReady: true, isConnected: true },
  ],
  turn: 1,
  score: { seat1: 0, seat2: 0 },
  currentRound: 1,
  roundSequence: 1,
  roundId: "m-ai-test-1-r-1",
  roundNonce: "nonce-1",
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
window.__precision.setReadyResponse = (s) => {
  window.__precision.readyResponse = s;
};

window.fetch = async (input) => {
  const url = typeof input === "string" ? input : input?.url ?? "";
  window.__precision.posts.push(url);
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
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
  return json({ success: true });
};

function makeSocket() {
  const listeners = new Map();
  const socket = {
    id: "socket-1",
    emit(event, payload, ack) {
      // Socket.IO timeout().emit() delivers (err, ack) — err is null on a
      // healthy ACK, which is what production does.
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
  root.render(<PrecisionMatchPage params={Promise.resolve({ matchId: "ai-test-1" })} />);
};

window.__precision.unmount = () => {
  if (root) root.unmount();
  root = null;
  document.getElementById("root").innerHTML = "";
};
