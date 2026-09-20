// qa/fiar-winline-harness.jsx
//
// Mounts the REAL multiplayer Four-In-A-Row page (its presentation-only
// imports are stubbed by qa/fiar-multiplayer-page.mjs) with a mocked
// `/api/four-in-a-row/game-state`, so a game with a known board can be
// rendered and measured in Chromium.
//
// Shared by qa/fiar-winline-check.mjs (finished win) and
// qa/fiar-turn-check.mjs (live turn/state hierarchy). The play-move response
// can be held open on purpose so the "move in flight" lock is observable.
import { createRoot } from "react-dom/client";
import ConnectFourGamePage from "../src/app/casino/four-in-a-row/game/[gameId]/PageClient";

const realFetch = window.fetch.bind(window);

window.__fiarGameState = null;

// Controls for the in-flight-move mock: a check can hold a play-move response
// open (to read the locked state deterministically) and then release it.
window.__releaseMove = null;
window.__heldMoves = 0;

window.fetch = (url, init) => {
  const href = String(url);
  if (href.includes("/api/four-in-a-row/play-move")) {
    window.__heldMoves += 1;
    return new Promise((resolve) => {
      window.__releaseMove = () =>
        resolve(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
    });
  }
  if (href.includes("/api/four-in-a-row/game-state")) {
    return Promise.resolve(
      new Response(JSON.stringify({ data: window.__fiarGameState }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
  if (href.includes("/api/spectators/count")) {
    return Promise.resolve(
      new Response(JSON.stringify({ success: true, count: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
  return realFetch(url, init);
};

let root = null;

window.mountGame = (state) => {
  window.__fiarGameState = state;
  if (root) root.unmount();
  root = createRoot(document.getElementById("root"));
  root.render(<ConnectFourGamePage />);
};
