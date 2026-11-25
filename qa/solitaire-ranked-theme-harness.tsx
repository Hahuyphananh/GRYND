// qa/solitaire-ranked-theme-harness.tsx
//
// The RANKED MATCH LAYOUT with the real table picker, for a mobile browser
// check. The board is a real solvable deal from the shared engine, and the
// picker/board wrapper markup is copied from
// src/app/casino/solitaire-duel/[matchId]/PageClient.tsx — the two meters above
// it, the right-aligned picker row, then the board's framed container. Mounting
// the whole match page would need a live match, a Clerk session and the socket;
// this keeps the part under test real while dropping only that environment.

import React from "react";
import { createRoot } from "react-dom/client";

import SolitaireBoard from "../src/components/solitaire-duel/SolitaireBoard";
import SolitaireThemePicker from "../src/components/solitaire-duel/SolitaireThemePicker";
import { createLocalMatch, playerView } from "../standalone/solitaire-duel/src/match";

const match = createLocalMatch({
  difficulty: "normal",
  seed: 20261111,
  nowMs: Date.now(),
  countdownMs: 0,
});
const view = playerView(match);

function Meter({ name, score }: { name: string; score: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/45">{name}</p>
      <p className="mt-1 font-mono text-lg font-bold text-white">{score}</p>
    </div>
  );
}

function RankedBoardLayout() {
  return (
    <div className="min-h-screen bg-[#05070d] px-3 pb-10 pt-4 text-white sm:px-6">
      <div className="mx-auto w-full max-w-4xl">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/40">
          Ranked · Solitaire Duel
        </p>

        {/* ── Competitive information (as the match page renders it) ────── */}
        <div className="mt-3 grid gap-2 sm:grid-cols-2" data-testid="ranked-meters">
          <Meter name="You" score="12/52" />
          <Meter name="Opponent" score="9/52" />
        </div>

        <div className="mt-3 space-y-3">
          {/* The match page's picker row, verbatim. */}
          <div className="flex justify-end">
            <SolitaireThemePicker />
          </div>

          {/* ── The board (the main focus) ──────────────────────────────── */}
          <div
            data-testid="ranked-board-frame"
            className="relative rounded-2xl border-2 border-[color:var(--gr-outline)] bg-black/45 p-2 shadow-[0_10px_0_-2px_rgba(3,8,20,0.85),inset_0_2px_0_rgba(255,255,255,0.06)] sm:p-4"
          >
            <SolitaireBoard view={view} interactive={false} onMove={() => {}} onInvalid={() => {}} />
          </div>
        </div>
      </div>
    </div>
  );
}

const host = document.getElementById("root");
if (host) {
  createRoot(host).render(<RankedBoardLayout />);
}
