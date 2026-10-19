// qa/hex-duel-lobby-harness.jsx
//
// Mounts the REAL Hex Duel LOBBY (src/app/casino/hex-duel/PageClient.tsx) with
// Clerk stubbed as signed-in and a SCRIPTED matchmaking backend, so
// qa/hex-duel-lobby-check.mjs can answer the question the split exists to
// settle:
//
//     "The create-game popup is inside the match page. Separate them: a
//      dedicated lobby with create-AI, create-PvP and the available games."
//
// Everything under test is the shipping component: the shared lobby chrome
// (PvpLobby, the same one Ultimate Tic-Tac-Toe and Pool Masters mount), the
// shared stake picker, the shared AI-difficulty picker and the lobby's own
// polling. Only the network is scripted — the real routes are account-gated and
// need a live database plus two players.
//
// The scripted world lives on `window.__world`, set by addInitScript before this
// bundle runs. `window.fetch` is replaced with a scripted backend that also logs
// every request, and the router records navigations instead of performing them,
// so "where did Create PvP send me" is an assertion and not a guess.

import React from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "../src/context/LanguageContext";
import { ThemeProvider } from "../src/context/ThemeContext";
import HexDuelLobbyPage from "../src/app/casino/hex-duel/PageClient";

const world = (window.__world = window.__world || {});
world.requests = world.requests || [];
world.createId = world.createId || 4242;
world.joinId = world.joinId || 99;
world.session = world.session || "session-abc";

/** A Response-alike — `res.ok`, `res.status` and `res.json()` are all that is read. */
const reply = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const OPEN_TABLE = {
  id: world.joinId,
  hostClerkId: "user_other",
  hostName: "Rival",
  wagerAmount: "10.00",
  status: "waiting",
};
const LIVE_MATCH = {
  id: 77,
  hostClerkId: "user_ace",
  hostName: "Ace",
  wagerAmount: "25.00",
  status: "in_progress",
};

window.fetch = async (input, init = {}) => {
  const raw = typeof input === "string" ? input : input?.url || "";
  const path = raw.split("?")[0];
  const method = String(init.method || "GET").toUpperCase();
  world.requests.push(`${method} ${path}`);

  switch (path) {
    case "/api/hex-duel/multiplayer/available":
      return reply({ success: true, games: [OPEN_TABLE], liveGames: [LIVE_MATCH] });
    case "/api/hex-duel/multiplayer/create":
      world.lastCreateBody = JSON.parse(init.body || "{}");
      return reply({ success: true, gameId: world.createId, wager: 10, newBalance: 90 });
    case "/api/hex-duel/multiplayer/join":
      world.lastJoinBody = JSON.parse(init.body || "{}");
      return reply({ success: true, gameId: world.joinId, wager: 10, newBalance: 90 });
    case "/api/hex-duel/start-game":
      world.lastAiBody = JSON.parse(init.body || "{}");
      return reply({ success: true, data: { aiSessionId: world.session, wager: 0, newBalance: 100 } });
    case "/api/spectators/count":
      return reply({ success: true, count: 3 });
    case "/api/get-user-tokens":
      return reply({ success: true, data: { balance: 100 } });
    default:
      // Ads / presence / quick-queue telemetry: benign, and never the subject.
      return reply({ success: true });
  }
};

const app = (
  <ThemeProvider>
    <LanguageProvider>
      <HexDuelLobbyPage />
    </LanguageProvider>
  </ThemeProvider>
);

createRoot(document.getElementById("root")).render(app);
