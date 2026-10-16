// qa/barrier-blitz-matchmaking-harness.jsx
//
// Mounts the REAL Barrier Blitz lobby (src/app/casino/barrier-blitz/PageClient)
// with Clerk stubbed as signed-in and a SCRIPTED matchmaking backend, so the
// browser check (qa/barrier-blitz-matchmaking-check.mjs) can answer the reported
// bug directly:
//
//     "When I click Find a Match and there's no other user joining, show the
//      waiting page — do not redirect me directly to the game page."
//
// The lobby is the shipping component, and everything below it is the shipping
// component too: the shared lobby chrome (PvpLobby), the shared waiting takeover
// (MatchWaiting) and the real polling hooks (useVisiblePoll / useSocketAwarePoll).
// Only the transport is scripted, because the real one is account-gated and
// would need a live database.
//
// The scripted world lives on `window.__matchmakingWorld`, set by addInitScript
// before this bundle runs:
//
//   { matchId, joined, matchStatus, lobbies }
//
//     joined      — true when the route finds an OPEN seat (the caller's opponent
//                   is already waiting), false when it opens a fresh lobby.
//     matchStatus — the status the per-match read reports while the caller waits;
//                   the check flips it to "playing" to simulate an opponent
//                   taking the seat.
//
// `window.__pushes` records every router.push the page performs, which is how
// "it did not navigate to the game page" is asserted.

import React from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider } from "../src/context/LanguageContext";
import { ThemeProvider } from "../src/context/ThemeContext";
import BarrierBlitzLobbyPage from "../src/app/casino/barrier-blitz/PageClient";

const world = (window.__matchmakingWorld = window.__matchmakingWorld || {});
world.matchId = world.matchId || "11111111-1111-4111-8111-111111111111";
world.joined = world.joined === true;
world.matchStatus = world.matchStatus || "waiting";
world.lobbies = Array.isArray(world.lobbies) ? world.lobbies : [];
world.requests = [];
world.createOrJoinCalls = 0;
world.cancels = 0;
// Every navigation the lobby asked for. The real router would leave the page;
// recording instead keeps the component mounted so the check can inspect what it
// rendered, which is the whole point of the assertion.
const pushes = (window.__pushes = []);

function bodyFor(path, method) {
  if (path === "/api/barricade/available") {
    return { status: 200, body: { success: true, data: world.lobbies } };
  }

  if (path === "/api/barricade/create-or-join") {
    world.createOrJoinCalls += 1;
    // `joined: true` means the caller took an open seat, so the match is live the
    // moment the route answers; `joined: false` means they now OWN a waiting
    // lobby, which is the case the reported bug is about.
    if (world.joined) world.matchStatus = "playing";
    return {
      status: 200,
      body: {
        success: true,
        data: {
          matchId: world.matchId,
          status: world.joined ? "playing" : "waiting",
          joined: world.joined,
        },
      },
    };
  }

  const cancel = /^\/api\/barricade\/match\/([^/]+)\/cancel$/.exec(path);
  if (cancel) {
    world.cancels += 1;
    world.matchStatus = "cancelled";
    return { status: 200, body: { success: true } };
  }

  const matchRead = /^\/api\/barricade\/match\/([^/]+)$/.exec(path);
  if (matchRead) {
    return {
      status: 200,
      body: {
        success: true,
        data: { matchId: matchRead[1], status: world.matchStatus },
      },
    };
  }

  if (path === "/api/get-user-tokens") {
    return {
      status: 200,
      body: {
        success: true,
        data: {
          balance: 5000,
          name: "Match Tester",
          selectedIcon: "icon-1",
          glowColor: null,
          nameColor: null,
          equippedCosmetics: {},
          totalTrophies: 3,
        },
      },
    };
  }
  if (path === "/api/user/is-admin") return { status: 200, body: { isAdmin: false } };
  if (path === "/api/user/daily-loss") {
    return { status: 200, body: { success: true, loss: 0 } };
  }
  if (path === "/api/titles") {
    return { status: 200, body: { success: true, selectedTitle: "" } };
  }
  // The platform Quick Queue readiness read and anything else the shared chrome
  // asks for: answer benignly so no unrelated failure can colour the result.
  return { status: 200, body: { success: true, data: null } };
}

window.fetch = async (url, init = {}) => {
  const path = String(url)
    .replace(/^https?:\/\/[^/]+/, "")
    .split("?")[0];
  const method = String(init?.method || "GET").toUpperCase();
  world.requests.push(`${method} ${path}`);
  const { status, body } = bodyFor(path, method);
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};

createRoot(document.getElementById("root")).render(
  <LanguageProvider>
    <ThemeProvider>
      <BarrierBlitzLobbyPage />
    </ThemeProvider>
  </LanguageProvider>
);

// The check needs to read the recorded pushes and the request log from the page.
window.__pushes = pushes;
