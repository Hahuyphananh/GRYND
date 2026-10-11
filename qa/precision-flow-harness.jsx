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
  /** Optional transform applied to every `get-match` response, standing in for
   *  the store's own due-transition pass on a read. */
  onServe: null,
  // ── Stop-response scripting ─────────────────────────────────────────────
  // The realtime proxy answers a stop with the route's response, and that
  // response now rides back on the ACK as well as on the room broadcast. Both
  // are scripted here so a test can choose which path delivers the result:
  //
  //   stopResponse    the post-stop snapshot the "server" returns
  //   stopAckMode     "withMatch" → the ACK carries it (what the realtime
  //                   server does now); "bare" → `{ success: true }` alone
  //   stopBroadcast   whether the room broadcast follows, like the fan-out
  //
  // "bare" + no broadcast is the reported case: the player's own result must
  // still arrive, because the page reconciles it over HTTPS rather than waiting
  // for a packet that never came.
  stopResponse: null,
  stopAckMode: "withMatch",
  stopBroadcast: false,
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
  // The platform endpoints the session host touches (presence, recently-played)
  // have nothing to do with this flow, and under `file://` a real fetch throws
  // and logs a console error — which would make "no page/console errors" fail on
  // harness plumbing instead of on the page. Answer them here so the check can
  // stay strict about real errors.
  if (/\/api\/(game-plays|presence\/)/.test(url)) {
    return json({ success: true });
  }
  if (url.includes("/api/precision/get-match")) {
    // A scripted "self-healing read": `readMatch` applies whatever transition
    // has come due before answering, so a driver can install an `onServe` that
    // returns the successor state once its stamped instant has passed. What the
    // page then receives is a server that advanced because it was READ — the
    // behaviour the pre-round countdown depends on when no socket event
    // announces the reveal.
    if (typeof window.__precision.onServe === "function") {
      const served = window.__precision.onServe(window.__precision.current);
      if (served) {
        window.__precision.current = served;
        return json({ success: true, match: served });
      }
    }
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
  const deliver = (event, payload) => {
    for (const handler of listeners.get(event) ?? []) handler(payload);
  };
  const socket = {
    id: "socket-1",
    emit(event, payload, ack) {
      // `emitStop` calls `socket.timeout(…).emit(event, packet, cb)`, and
      // Socket.IO delivers that callback as `(err, ack)` — `err` is null on a
      // healthy ACK. Calling the callback with the ack payload in the FIRST
      // slot made every stop look like an ACK timeout, which silently pushed
      // the check down the HTTPS-fallback path (and would hide a real
      // "stop accepted" from the page).
      if (event !== "precision:stop" || typeof ack !== "function") return;
      const script = window.__precision;
      const response = script.stopResponse;
      if (!response) {
        setTimeout(() => ack(null, { success: true }), 0);
        return;
      }
      setTimeout(() => {
        // Mirror the realtime proxy: the ACK carries the route's response (and
        // the snapshot inside it, unless the test scripted a bare ACK), then the
        // room fan-out happens — or does not, when the test is exercising a
        // broadcast that never arrives.
        ack(
          null,
          script.stopAckMode === "bare"
            ? { success: true }
            : {
                success: true,
                match: response.match,
                bothStopped: response.bothStopped === true,
                roundWinnerSeat: response.roundWinnerSeat ?? null,
                matchFinished: response.matchFinished === true,
              }
        );
        if (script.stopBroadcast) {
          deliver("precision:roundResult", {
            matchId: response.match?.matchId,
            match: response.match,
            bothStopped: true,
            roundWinnerSeat: response.roundWinnerSeat ?? null,
            matchFinished: response.matchFinished === true,
          });
        }
      }, 0);
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
    /** Room fan-out: hand an event to every listener the page registered. */
    deliver,
  };
  return socket;
}

window.__precision.socket = makeSocket();

/**
 * Broadcast into the match room the way the realtime server does. The server
 * emits `precision:roundArmStart` when the arming countdown is applied and
 * `precision:roundResult` when a round is decided, so a driver that advances the
 * scripted state has to say so here too — otherwise it is testing a player whose
 * socket is silent, which is a different scenario (and the one the stop-flow
 * reconciliation exists for).
 */
window.__precision.broadcast = (event, payload) =>
  window.__precision.socket.deliver(event, payload);

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
