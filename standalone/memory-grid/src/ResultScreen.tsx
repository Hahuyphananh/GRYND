// standalone/memory-grid/src/ResultScreen.tsx
//
// The post-match panel, in one place and with no state of its own, so VICTORY,
// DEFEAT and DRAW are literally the same screen — and each can be rendered and
// checked as plain markup (tests/memory-grid-standalone.test.mjs).
//
// Everything it prints is handed in. The totals, the rounds won and the
// round-by-round scores come from the controller's view, which got them from the
// shared engine; the duration is formatted by the caller. Nothing here decides a
// rule or invents a number.
//
// The GRYND CTA is the one optional part. It is rendered only when the build
// turned it on (see `portal-config.ts`); it is an ordinary anchor that opens a
// new tab and requests nothing on load; it sits below the result information and
// above the replay controls; and its copy never claims this match was saved or
// transferred anywhere.

import type { LocalMatchView, RoundSnapshot } from "./match";
import type { PortalConfig } from "./portal-config";

export type ResultScreenProps = {
  view: LocalMatchView;
  /** The opponent's display name — "GRYND AI" in this build. */
  botName: string;
  /** The whole match, already formatted (see `matchTimeLabel` in App.tsx). */
  durationLabel: string;
  /** The build's CTA configuration; `ctaEnabled` decides if it is rendered. */
  cta: PortalConfig;
  onReplay: () => void;
  onChangeDifficulty: () => void;
};

const OUTCOME_LABELS: Record<string, string> = {
  win: "VICTORY",
  loss: "DEFEAT",
  draw: "DRAW",
};

/** R1–R5, then TBn for the tiebreak round. */
function roundLabel(roundNumber: number, roundsPerMatch: number): string {
  return roundNumber > roundsPerMatch ? `TB${roundNumber - roundsPerMatch}` : `R${roundNumber}`;
}

function winnerLabel(round: RoundSnapshot, botName: string): string {
  if (round.roundWinner === "player1") return "You";
  if (round.roundWinner === "player2") return botName;
  return "Draw";
}

export default function ResultScreen({
  view,
  botName,
  durationLabel,
  cta,
  onReplay,
  onChangeDifficulty,
}: ResultScreenProps) {
  const outcome = OUTCOME_LABELS[String(view.viewerOutcome ?? "")] ?? "MATCH OVER";

  return (
    <div
      data-testid="result-overlay"
      className="fixed inset-0 z-40 flex items-center justify-center bg-[#04070f]/85 p-4"
    >
      <div className="max-h-[92vh] w-full max-w-sm overflow-y-auto rounded-3xl border border-white/[0.12] bg-[#0a1224] p-5 text-center shadow-[0_18px_35px_rgba(3,8,23,0.6)]">
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-amber-400">
          {view.isTiebreak ? "Tiebreak round decided" : "Match complete"}
        </p>
        <h2 data-testid="result-outcome" className="mt-1 text-3xl font-black tracking-tight">
          {outcome}
        </h2>
        <p
          data-testid="result-duration"
          className="mt-1 text-[10px] uppercase tracking-[0.22em] text-white/40"
        >
          Match time {durationLabel}
        </p>

        <div
          data-testid="result-totals"
          className="mt-4 space-y-2 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-left"
        >
          <TotalLine
            label="You"
            tone="amber"
            total={view.p1Total}
            roundWins={view.p1Score}
          />
          <TotalLine
            label={botName}
            tone="cyan"
            total={view.p2Total}
            roundWins={view.p2Score}
          />
        </div>

        <div
          data-testid="result-rounds"
          className="mt-3 rounded-xl border border-white/10 bg-white/[0.03] p-3"
        >
          <p className="mb-2 text-[10px] font-black uppercase tracking-[0.2em] text-white/40">
            Round by round
          </p>
          <div className="space-y-1">
            {view.rounds.map((round) => {
              const youWon = round.roundWinner === "player1";
              const botWon = round.roundWinner === "player2";
              return (
                <div
                  key={round.roundNumber}
                  data-testid="round-row"
                  className="flex items-center justify-between gap-2 text-[11px] tabular-nums"
                >
                  <span className="w-7 text-left font-bold uppercase tracking-wider text-white/35">
                    {roundLabel(round.roundNumber, view.roundsPerMatch)}
                  </span>
                  <span
                    data-round-score="player1"
                    className={youWon ? "font-black text-yellow-300" : "text-white/70"}
                  >
                    {round.p1RoundScore}
                  </span>
                  <span className="text-white/20">–</span>
                  <span
                    data-round-score="player2"
                    className={botWon ? "font-black text-cyan-300" : "text-white/70"}
                  >
                    {round.p2RoundScore}
                  </span>
                  <span
                    data-round-winner={round.roundWinner}
                    className={`w-20 text-right text-[10px] uppercase tracking-wider ${
                      youWon ? "text-yellow-300/80" : botWon ? "text-cyan-300/80" : "text-white/35"
                    }`}
                  >
                    {winnerLabel(round, botName)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* The CTA is OFF unless this package was built for a portal that allows
            it (see src/portal-config.ts). It is a secondary action, so it sits
            below the result and above the replay controls, never replacing them,
            and it never claims this match was saved or transferred. */}
        {cta.ctaEnabled ? (
          <div
            data-testid="grynd-cta"
            className="mt-4 rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] p-3 text-left"
          >
            <p className="text-[11px] leading-snug text-white/70">{cta.ctaQuestion}</p>
            <a
              data-testid="grynd-cta-link"
              href={cta.ctaUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="gr-focusable mt-2 inline-flex w-full items-center justify-center rounded-lg border border-amber-400/40 bg-amber-400/[0.08] px-3 py-2 text-[11px] font-black uppercase tracking-[0.14em] text-amber-200 transition hover:bg-amber-400/15 hover:text-white"
            >
              {cta.ctaLabel}
            </a>
          </div>
        ) : null}

        <button
          type="button"
          data-testid="result-replay"
          onClick={onReplay}
          className="gr-focusable mt-4 w-full rounded-xl bg-amber-500 px-4 py-3 text-sm font-black uppercase tracking-[0.18em] text-black transition hover:brightness-110"
        >
          Play again
        </button>
        <button
          type="button"
          data-testid="result-change-difficulty"
          onClick={onChangeDifficulty}
          className="gr-focusable mt-2 w-full rounded-xl border border-white/15 px-4 py-2.5 text-[11px] font-bold uppercase tracking-[0.18em] text-white/60 transition hover:border-white/30 hover:text-white"
        >
          Change difficulty
        </button>
      </div>
    </div>
  );
}

function TotalLine({
  label,
  tone,
  total,
  roundWins,
}: {
  label: string;
  tone: "amber" | "cyan";
  total: number;
  roundWins: number;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10px] font-black uppercase tracking-[0.16em] text-white/60">
        {label}
      </span>
      <span className="text-[11px] text-white/35">
        {roundWins} round win{roundWins === 1 ? "" : "s"}
      </span>
      <span
        data-total={tone}
        className={`text-lg font-black tabular-nums ${
          tone === "amber" ? "text-yellow-300" : "text-cyan-300"
        }`}
      >
        {total}
      </span>
    </div>
  );
}
