// qa/hex-duel-turn-harness.jsx
//
// Integration harness for the Hex Duel turn-transition polish. It mounts the
// REAL `src/app/casino/hex-duel/PageClient.tsx` (only the noisy siblings are
// stubbed by qa/hex-duel-turn-check.mjs: Clerk, the router, analytics, the
// socket, the nav bar, the emotes/presence/recording hooks, the audio module
// and the first-visit rules) and plays a real FOR-FUN match, which is the
// mode the bug was reported in: `handleStartFun` enables the AI, so ending a
// turn hands the board to player2 and the status bar loses its End Turn
// button for as long as the AI is on the clock.
//
// It also exposes a second, CONTROLLED mount of the real `HexBoard` so the
// number roll can be driven deterministically (identical props, two changes
// in quick succession) without waiting for the AI to move.
//
// Everything the check needs is on `window.__hex`:
//   * `errors`        — window errors / unhandled rejections while mounted
//   * `mountControlledBoard(id)` — render the real HexBoard into an element
//   * `setBoardProps(p)`         — re-render that board with new props
//   * `setTile(key, patch)`      — patch one tile's data (drives the roll)
//   * `unmountControlled()`      — tear it down

import React from "react";
import { createRoot } from "react-dom/client";
import HexDuelPage from "../src/app/casino/hex-duel/PageClient";
import HexBoard from "../src/components/HexBoard";

const state = {
  errors: [],
  cues: [],
  mountControlledBoard: null,
  setBoardProps: null,
  setTile: null,
  unmountControlled: null,
};
window.__hex = state;

window.addEventListener("error", (e) => {
  state.errors.push(String(e.message || e));
});
window.addEventListener("unhandledrejection", (e) => {
  state.errors.push("rejection: " + String(e.reason));
});

// ── The real page ─────────────────────────────────────────────────────────
createRoot(document.getElementById("root")).render(<HexDuelPage />);

// ── Controlled HexBoard (deterministic number-roll scenarios) ─────────────
const INITIAL_BOARD = {
  grid: [
    [
      { x: 0, y: 0, owner: "player1", troops: 5, shield: 0 },
      { x: 1, y: 0, owner: "player2", troops: 5, shield: 0 },
    ],
    [
      { x: 0, y: 1, owner: "neutral", troops: 5, shield: 0 },
      { x: 1, y: 1, owner: "neutral", troops: 5, shield: 0 },
    ],
  ],
  selectedTile: null,
  onTileClick: () => {},
};

state.mountControlledBoard = (elementId) => {
  const host = document.getElementById(elementId);
  let publish = null;
  const root = createRoot(host);

  function Controlled() {
    const [props, setProps] = React.useState(INITIAL_BOARD);
    publish = setProps;
    return <HexBoard {...props} />;
  }

  root.render(<Controlled />);
  state.setBoardProps = (patch) => publish((prev) => ({ ...prev, ...patch }));
  state.setTile = (key, patch) => {
    const [x, y] = key.split(",").map(Number);
    publish((prev) => ({
      ...prev,
      grid: prev.grid.map((row) =>
        row.map((tile) => (tile.x === x && tile.y === y ? { ...tile, ...patch } : tile)),
      ),
    }));
  };
  state.unmountControlled = () => root.unmount();
};
