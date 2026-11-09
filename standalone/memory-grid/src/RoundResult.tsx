// standalone/memory-grid/src/RoundResult.tsx
//
// The round-result view: the answer key, both reconstructions, and the numbers
// the engine scored them with.
//
// It is a pure rendering of `RoundSnapshot` — the same shape the server stores in
// `memory_grid_rounds` — so nothing here computes accuracy, a round winner or a
// total. Every value printed comes from the controller, which got it from the
// shared engine.
//
// The verdicts use hue AND position, never hue alone: the answer key is amber,
// a correct pick is emerald, a wrong pick is red, and a missed tile keeps a thin
// amber edge with no face so it reads as "this one was lit and you missed it"
// rather than as another wrong pick.

import type { LocalMatchView, Pattern, ReconstructionFlip, RoundSnapshot } from "./match";

// The same asset reference the live board uses — Vite emits the file beside the
// bundle, so the review sheet loads nothing at runtime.
const LOGO_URL = new URL("../../../src/images/logo1.png", import.meta.url).href;

export type RoundResultProps = {
  view: LocalMatchView;
  round: RoundSnapshot;
  /** The opponent's display name — "GRYND AI" in this build. */
  botName: string;
};

type ReviewTone = "pattern" | "picks";

const REVIEW_TONE = {
  rest: "border-[color:var(--gr-outline)] bg-[#0e2743] shadow-[inset_0_2px_0_rgba(255,255,255,0.08),inset_0_-2px_0_rgba(3,8,20,0.5)]",
  lit: "border-[color:var(--gr-outline)] bg-[#c98513] shadow-[inset_0_2px_0_rgba(255,232,160,0.5),inset_0_-2px_0_rgba(95,58,2,0.55)]",
  correct:
    "border-[color:var(--gr-outline)] bg-[#10603f] shadow-[inset_0_2px_0_rgba(150,255,205,0.4),inset_0_-2px_0_rgba(0,55,35,0.5)]",
  wrong:
    "border-[color:var(--gr-outline)] bg-[#5a1420] shadow-[inset_0_2px_0_rgba(255,170,180,0.35),inset_0_-2px_0_rgba(70,0,10,0.55)]",
  missed: "border-amber-400/70 bg-[#0b1a33]",
} as const;

/** One grid of the review sheet: the answer key, or one seat's reconstruction. */
function ReviewGrid({
  title,
  badge,
  pattern,
  picks,
  tone,
  flip,
}: {
  title: string;
  badge: string;
  pattern: Pattern;
  picks: number[];
  tone: ReviewTone;
  flip?: ReconstructionFlip | null;
}) {
  const size = Math.max(1, Math.trunc(Number(pattern.size) || 3));
  const total = size * size;
  const active = new Set(pattern.active);
  const picked = new Set(picks);

  return (
    <div
      data-testid="review-grid"
      data-review={tone}
      className="mb-5 rounded-2xl border-2 border-[color:var(--gr-outline)] bg-[#08142f] p-4 shadow-[inset_0_2px_0_rgba(255,255,255,0.05)]"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-black uppercase tracking-widest text-white/70">{title}</h3>
        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white/40">
          {badge}
        </span>
      </div>

      <div
        className="mx-auto grid max-w-[260px] gap-1.5"
        style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: total }, (_, index) => {
          const isActive = active.has(index);
          const isPicked = picked.has(index);

          let cell: string = REVIEW_TONE.rest;
          let face = false;
          if (tone === "pattern") {
            if (isActive) {
              cell = REVIEW_TONE.lit;
              face = true;
            }
          } else if (isPicked) {
            cell = isActive ? REVIEW_TONE.correct : REVIEW_TONE.wrong;
            face = true;
          } else if (isActive) {
            cell = REVIEW_TONE.missed;
          }

          return (
            <div
              key={index}
              data-testid="review-tile"
              className={`relative aspect-square overflow-hidden rounded-[3px] border-2 ${cell}`}
            >
              {face ? (
                <img
                  src={LOGO_URL}
                  alt=""
                  draggable={false}
                  className="absolute inset-0 h-full w-full object-contain p-1"
                />
              ) : null}
            </div>
          );
        })}
      </div>

      {flip ? (
        <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
          <Stat label="Accuracy" value={`${Number(flip.accuracyPct ?? 0).toFixed(1)}%`} />
          <Stat
            label="Time"
            value={`${(Number(flip.completionTimeMs ?? 0) / 1000).toFixed(2)}s`}
          />
          <Stat label="Score" value={`${Number(flip.score ?? 0)}/100`} />
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5">
      <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">{label}</p>
      <p
        data-testid="result-stat"
        data-stat={label.toLowerCase()}
        className="mt-0.5 font-black tabular-nums text-amber-300"
      >
        {value}
      </p>
    </div>
  );
}

export default function RoundResult({ view, round, botName }: RoundResultProps) {
  // A finished match has no live deadline; the review is still shown.
  const msLeft = Math.max(0, Number(view.msLeft) || 0);
  const seconds = Math.ceil(msLeft / 1000);
  const finalRound = round.roundNumber >= view.roundsPerMatch;
  const countdown =
    msLeft > 0 ? `${finalRound ? "Final results" : "Next round"} in ${seconds}s…` : "…";

  const pattern = round.boardSnapshot ?? { size: 3, total: 9, active: [] };
  const playerFlip = round.flips.find((flip) => flip.seat === "player1") ?? null;
  const botFlip = round.flips.find((flip) => flip.seat === "player2") ?? null;

  return (
    <div data-testid="round-result">
      <div className="mb-5 text-center">
        <h1 className="flex items-center justify-center gap-3 bg-linear-to-r from-amber-300 via-amber-400 to-yellow-500 bg-clip-text text-3xl font-extrabold tracking-wide text-transparent drop-shadow-[0_0_18px_rgba(251,191,36,0.5)]">
          Memory Grid
        </h1>
        <div className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-emerald-400/40 bg-emerald-950/40 px-4 py-1.5 text-sm font-black text-emerald-300">
          {view.isTiebreak
            ? `TIEBREAK ROUND ${round.roundNumber}`
            : `ROUND ${round.roundNumber}/${view.roundsPerMatch}`}
        </div>
        <p className="mt-2 text-sm text-white/60">{countdown}</p>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-amber-400/70 bg-amber-500/10 p-3 text-center">
          <p className="text-[10px] font-bold uppercase tracking-widest text-white/50">You</p>
          <p className="mt-0.5 text-3xl font-black tabular-nums text-yellow-300">{view.p1Total}</p>
          <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">pts</p>
          <p className="mt-0.5 text-[10px] text-white/40">
            {view.p1Score} round win{view.p1Score === 1 ? "" : "s"}
          </p>
        </div>
        <div className="rounded-2xl border border-cyan-400/70 bg-cyan-500/10 p-3 text-center">
          <p className="text-[10px] font-bold uppercase tracking-widest text-white/50">{botName}</p>
          <p className="mt-0.5 text-3xl font-black tabular-nums text-cyan-300">{view.p2Total}</p>
          <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">pts</p>
          <p className="mt-0.5 text-[10px] text-white/40">
            {view.p2Score} round win{view.p2Score === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      <ReviewGrid
        title="Correct Pattern"
        badge="answer key"
        pattern={pattern}
        picks={pattern.active}
        tone="pattern"
      />
      <ReviewGrid
        title="Your Reconstruction"
        badge="you"
        pattern={pattern}
        picks={playerFlip?.picks ?? []}
        tone="picks"
        flip={playerFlip}
      />
      <ReviewGrid
        title={`${botName}: Reconstruction`}
        badge="bot"
        pattern={pattern}
        picks={botFlip?.picks ?? []}
        tone="picks"
        flip={botFlip}
      />
    </div>
  );
}
