// standalone/solitaire-duel/src/ResultScreen.tsx
//
// The post-match panel, in one place and with no state of its own, so VICTORY,
// DEFEAT and a draw are literally the same screen — and each of them can be
// rendered and checked as plain markup (tests/solitaire-duel-standalone.test.mjs).
//
// Everything it prints is handed in: the outcome, the duration and the two
// progress lines come from the shared engine and `ui.ts`, exactly as the server
// settlement produces them. Nothing here decides a rule or invents a number.
//
// The GRYND CTA is the one optional part. It is rendered only when the build
// turned it on (see `portal-config.ts`); it is an ordinary anchor that opens a
// new tab and requests nothing on load; it sits below the result information and
// above the replay controls; and its copy never claims this match was saved or
// transferred anywhere.

import React from "react";

import { progressLabel } from "../../../src/lib/solitaire-duel/ui";
import type { SeatProgress } from "../../../src/lib/solitaire-duel/types";
import type { PortalConfig } from "./portal-config";

export type ResultScreenProps = {
  /** `outcomeLabel(viewerOutcome(...))` — "VICTORY", "DEFEAT" or "DRAW". */
  outcome: string;
  /** `resolutionLabel(...)`, or null when the engine gave none. */
  resolution: string | null;
  /** The race time, already formatted (see `matchTimeLabel` in App.tsx). */
  durationLabel: string;
  /** The player's settlement numbers, printed exactly as they were compared. */
  playerProgress: SeatProgress;
  /** The bot's settlement numbers. */
  botProgress: SeatProgress;
  /** e.g. `Bot · Normal` — the tier this match was played against. */
  botLabel: string;
  /** The build's CTA configuration; `ctaEnabled` decides if it is rendered. */
  cta: PortalConfig;
  onReplay: () => void;
  onChangeDifficulty: () => void;
};

export default function ResultScreen({
  outcome,
  resolution,
  durationLabel,
  playerProgress,
  botProgress,
  botLabel,
  cta,
  onReplay,
  onChangeDifficulty,
}: ResultScreenProps) {
  return (
    <div
      data-testid="result-overlay"
      className="fixed inset-0 z-40 flex items-center justify-center bg-[#04070f]/85 p-4"
    >
      <div className="max-h-[92vh] w-full max-w-sm overflow-y-auto rounded-3xl border border-white/[0.12] bg-[#0a1224] p-5 text-center shadow-[0_18px_35px_rgba(3,8,23,0.6)]">
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-[#00e5ff]">
          {resolution ?? "Match over"}
        </p>
        <h2 data-testid="result-outcome" className="mt-1 text-3xl font-black tracking-tight">
          {outcome || "MATCH OVER"}
        </h2>
        <p
          data-testid="result-duration"
          className="mt-1 text-[10px] uppercase tracking-[0.22em] text-white/40"
        >
          Match time {durationLabel}
        </p>

        <div className="mt-4 space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-left">
          <ResultLine label="You" progress={playerProgress} />
          <ResultLine label={botLabel} progress={botProgress} />
        </div>

        {/* The CTA is OFF unless this package was built for a portal that allows
            it (see src/portal-config.ts). It is a secondary action, so it sits
            below the result and above the replay controls, never replacing them,
            and it never claims this match was saved or transferred. */}
        {cta.ctaEnabled ? (
          <div
            data-testid="grynd-cta"
            className="mt-4 rounded-2xl border border-[#00e5ff]/25 bg-[#00e5ff]/[0.06] p-3 text-left"
          >
            <p className="text-[11px] leading-snug text-white/70">{cta.ctaQuestion}</p>
            <a
              data-testid="grynd-cta-link"
              href={cta.ctaUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="gr-focusable mt-2 inline-flex w-full items-center justify-center rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/[0.08] px-3 py-2 text-[11px] font-black uppercase tracking-[0.14em] text-[#9beaff] transition hover:bg-[#00e5ff]/15 hover:text-white"
            >
              {cta.ctaLabel}
            </a>
          </div>
        ) : null}

        <button
          type="button"
          data-testid="result-replay"
          onClick={onReplay}
          className="gr-focusable mt-4 w-full rounded-xl bg-[#00e5ff] px-4 py-3 text-sm font-black uppercase tracking-[0.18em] text-[#04070f] transition hover:brightness-110"
        >
          Play again
        </button>
        <button
          type="button"
          data-testid="result-change-difficulty"
          onClick={onChangeDifficulty}
          className="gr-focusable mt-2 w-full rounded-xl border border-white/15 px-4 py-2.5 text-[11px] font-bold uppercase tracking-[0.18em] text-white/60 transition hover:border-white/30 hover:text-white"
        >
          Change opponent
        </button>
      </div>
    </div>
  );
}

function ResultLine({ label, progress }: { label: string; progress: SeatProgress }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10px] font-black uppercase tracking-[0.16em] text-white/60">
        {label}
      </span>
      <span className="tabular-nums text-[11px] text-white/45">{progressLabel(progress)}</span>
    </div>
  );
}
