// qa/joiner-first-dnb-harness.jsx
//
// Mounts the REAL Dots & Boxes match page with a mocked `/game-state`, so a
// browser can prove the joining seat really owns the opening turn.
//
// `window.mountMatch({ role })` re-mounts as the guest or the host. Everything
// the check inspects lives on `window.__dnb`:
//   * errors — window errors / unhandled rejections
//   * posts  — every POST the page made, `{ url, body }`
//   * mountMatch({ role }) — re-mount with that seat
//
// Run through qa/joiner-first-dnb-check.mjs, which bundles this file with the
// page's presentation-only siblings stubbed out.

import React from "react";
import { createRoot } from "react-dom/client";
import DotsAndBoxesGamePage from "../src/app/casino/dots-and-boxes/game/[gameId]/PageClient";
import { createInitialState } from "../src/lib/dotsAndBoxesEngine.ts";

const state = {
  errors: [],
  posts: [],
  role: "guest",
  socket: null,
};
window.__dnb = state;

window.addEventListener("error", (e) => {
  state.errors.push(String(e.message || e));
});
window.addEventListener("unhandledrejection", (e) => {
  state.errors.push("rejection: " + String(e.reason));
});

const gameState = () => ({
  ...createInitialState(),
  currentTurn: "guest",
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
  if (href.includes("/api/dots-and-boxes/game-state")) {
    return Promise.resolve(
      json({
        success: true,
        data: {
          id: 7,
          status: "in_progress",
          isAiGame: false,
          role: state.role,
          hostClerkId: "host1",
          guestClerkId: "guest1",
          hostName: "Host",
          guestName: "You",
          hostIconKey: null,
          guestIconKey: null,
          hostIsGuest: false,
          guestIsGuest: false,
          hostNameColor: null,
          guestNameColor: null,
          hostProfileFrame: null,
          guestProfileFrame: null,
          gameState: gameState(),
          remainingEdges: 84,
          timerSeconds: 60,
          moveDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
          remainingSeconds: 60,
          betAmount: 0,
        },
      }),
    );
  }
  if (href.includes("/api/dots-and-boxes/draw-edge")) {
    const last = state.posts[state.posts.length - 1]?.body ?? {};
    const next = gameState();
    next.edges = [`${last.type ?? "h"}:${last.row ?? 0},${last.col ?? 0}`];
    next.edgeOwners = { [next.edges[0]]: state.role };
    next.currentTurn = "host";
    return Promise.resolve(
      json({
        success: true,
        gameState: next,
        remaining: 83,
        moveDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
  }
  if (href.includes("/api/spectators/count")) {
    return Promise.resolve(json({ success: true, count: 0 }));
  }
  if (href.includes("/api/dots-and-boxes/")) {
    return Promise.resolve(json({ success: true }));
  }
  return realFetch(url, init);
};

let root = null;

window.mountMatch = ({ role }) => {
  state.role = role;
  state.posts.length = 0;
  if (root) root.unmount();
  root = createRoot(document.getElementById("root"));
  root.render(<DotsAndBoxesGamePage />);
};

window.mountMatch({ role: "guest" });
