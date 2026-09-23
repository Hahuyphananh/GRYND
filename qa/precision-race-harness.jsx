// qa/precision-race-harness.jsx
//
// Temporary harness: mounts the REAL Precision rocket-race surfaces with
// fabricated (but shape-accurate) props so qa/precision-mobile-check.mjs can
// screenshot + measure them in a real browser at phone widths.
//
// Three entry points, all plain-JSON so the check never has to build React
// elements across the evaluate boundary:
//
//   window.renderRace(payload)        → the live two-lane board (active phase)
//   window.renderRoundResult(payload) → the per-round result overlay (which
//                                       embeds the compact board)
//   window.renderPopup(payload)       → the end-of-match popup (which embeds
//                                       the compact board under "Last round")
//
// The lane payload is flattened (`seat1Frozen` / `seat2Frozen` /
// `localSeat`) because that is how the match page decides which lane parks
// and which one keeps flying — a lane with `frozenElapsedMs == null` is
// still climbing, exactly as `raceLanes(false)` builds it.
import React from "react";
import { createRoot } from "react-dom/client";
import PrecisionRocketRace from "../src/components/precision/PrecisionRocketRace";
import PrecisionRoundResultPanel from "../src/components/precision/PrecisionRoundResultPanel";
import PrecisionResultPopup from "../src/components/precision/PrecisionResultPopup";

const root = createRoot(document.getElementById("root"));
const noop = () => {};

const buildLanes = (p) => [
  {
    seat: 1,
    name: p.seat1Name,
    isSelf: p.localSeat === 1,
    frozenElapsedMs: p.seat1Frozen ?? null,
  },
  {
    seat: 2,
    name: p.seat2Name,
    isSelf: p.localSeat === 2,
    frozenElapsedMs: p.seat2Frozen ?? null,
  },
];

// The match page hands the board a full-width column inside the page gutter
// (`px-3` on phones, `sm:px-6` above) — mirror that shell so the board is
// measured at the width a player actually gets, not at a bare viewport.
const Shell = ({ children }) => (
  <div className="min-h-screen bg-gradient-to-b from-[#06120f] to-[#050816] px-3 pb-24 pt-4 text-white sm:px-6">
    <div className="mx-auto w-full max-w-3xl">{children}</div>
  </div>
);

// The live round mounts its STOP control INSIDE the board's centre column
// (`action`), directly under the elapsed clock. `withStopAction` mirrors that
// arrangement so the check can measure the real slot: the button is sized to
// the column (`w-full`) and must never reach into a lane.
const stopAction = (
  <button
    type="button"
    data-testid="precision-race-action-button"
    className="w-full rounded-lg border-2 border-red-400/70 bg-gradient-to-b from-red-500 to-red-600 px-1 py-3 text-[11px] font-black leading-tight tracking-widest text-white"
  >
    STOP
  </button>
);

window.renderRace = (p) =>
  root.render(
    <Shell>
      <PrecisionRocketRace
        phase={p.phase}
        roundKey={p.roundKey}
        targetMs={p.targetMs}
        liveElapsedMs={p.liveElapsedMs}
        countdownMs={p.countdownMs ?? null}
        lanes={buildLanes(p)}
        action={p.withStopAction ? stopAction : undefined}
      />
    </Shell>
  );

window.renderRoundResult = (p) =>
  root.render(
    <PrecisionRoundResultPanel
      targetMs={p.targetMs}
      seat1Name={p.seat1Name}
      seat1ElapsedMs={p.seat1ElapsedMs}
      seat1DiffMs={p.seat1DiffMs}
      seat2Name={p.seat2Name}
      seat2ElapsedMs={p.seat2ElapsedMs}
      seat2DiffMs={p.seat2DiffMs}
      roundWinnerSeat={p.roundWinnerSeat ?? null}
      localSeat={p.localSeat ?? 1}
      onDismiss={noop}
    />
  );

window.renderPopup = (p) =>
  root.render(
    <PrecisionResultPopup
      // `openedAt` is stamped here so the replay countdown starts fresh.
      popup={{ ...p.popup, openedAt: Date.now() }}
      onReplay={noop}
      onReturnToLobby={noop}
      replayRequested={false}
      opponentReplayRequested={false}
      returnChosen={false}
      race={{ targetMs: p.targetMs, lanes: buildLanes(p) }}
    />
  );

// Bring the embedded board into view inside the popup's own scroll container
// (`fixed inset-0 overflow-y-auto`) so its screenshot is not the header.
window.scrollPopupToRace = () => {
  const board = document.querySelector('[data-testid="precision-rocket-race"]');
  if (board) board.scrollIntoView({ block: "center" });
};
