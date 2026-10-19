// qa/joiner-first-hex-harness.jsx
//
// Mounts the REAL Hex Duel match page for an ONLINE match, with the server's
// status payload mocked, so a browser can prove which seat owns the opening
// turn. `window.mountMatch({ amHost })` re-mounts the page for a fresh seat.
//
// Everything the check inspects lives on `window.__hex`:
//   * errors  — window errors / unhandled rejections
//   * posts   — every POST the page made, `{ url, body }`
//   * amHost  — the seat the mocked status endpoint reports
//   * mountMatch({ amHost }) — re-mount as host (`true`) or guest (`false`)
//
// Run through qa/joiner-first-hex-check.mjs, which bundles this file with the
// page's presentation-only siblings stubbed out.

import React from "react";
import { createRoot } from "react-dom/client";
import HexDuelPage from "../src/app/casino/hex-duel/game/[matchId]/PageClient";

const state = {
  errors: [],
  posts: [],
  amHost: false,
  socket: null,
  route: { matchId: "42", search: "host=0" },
};
window.__hex = state;

window.addEventListener("error", (e) => {
  state.errors.push(String(e.message || e));
});
window.addEventListener("unhandledrejection", (e) => {
  state.errors.push("rejection: " + String(e.reason));
});

const json = (body) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const realFetch = window.fetch.bind(window);
window.fetch = (url, init) => {
  const href = String(url);
  if (init?.method === "POST") {
    let body = null;
    try {
      body = JSON.parse(init.body || "{}");
    } catch {
      body = null;
    }
    state.posts.push({ url: href, body });
  }
  if (href.includes("/api/hex-duel/multiplayer/status")) {
    return Promise.resolve(
      json({
        success: true,
        game: {
          amHost: state.amHost,
          isReady: true,
          currentTurn: "player2",
          status: "in_progress",
          player1Id: "host1",
          player2Id: "guest1",
          player1Name: "Host",
          player2Name: "You",
          player1IconKey: null,
          player2IconKey: null,
          player1NameColor: null,
          player2NameColor: null,
          player1ProfileFrame: null,
          player2ProfileFrame: null,
        },
      }),
    );
  }
  if (href.includes("/api/hex-duel/multiplayer/actions")) {
    return Promise.resolve(
      json({ success: true, actions: [], latestActionId: 0 }),
    );
  }
  if (href.includes("/api/spectators/count")) {
    return Promise.resolve(json({ success: true, count: 0 }));
  }
  if (href.includes("/api/hex-duel/")) {
    return Promise.resolve(json({ success: true }));
  }
  return realFetch(url, init);
};

let root = null;

window.mountMatch = ({ amHost }) => {
  state.amHost = amHost;
  state.posts.length = 0;
  state.route = { matchId: "42", search: amHost ? "host=1" : "host=0" };
  if (root) root.unmount();
  root = createRoot(document.getElementById("root"));
  root.render(<HexDuelPage />);
};

window.mountMatch({ amHost: false });
