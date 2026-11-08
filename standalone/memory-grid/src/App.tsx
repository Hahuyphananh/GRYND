// standalone/memory-grid/src/App.tsx
//
// The standalone screen: menu → ready → memorize → reconstruct → round result →
// finished, with nothing else.
//
// What this file owns is presentation and the clock. Every rule, every pattern
// and every score comes from `./match` (which in turn is the shared engine), so
// this UI cannot drift from the GRYND game.
//
// The clock: a 100 ms tick advances the match and drives the countdown. The
// controller derives every phase boundary from an absolute deadline, so a slow
// frame or a background tab cannot stretch the memorize preview or shorten the
// reconstruction — it only delays when the next frame paints.
//
// This file is deliberately the ONLY stateful screen: the board and the round
// review are pure renderers of the controller's view.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  AI_DIFFICULTIES,
  AI_DIFFICULTY_LABELS,
  type AiDifficulty,
} from "../../../src/lib/aiDifficulty";
import { MATCH_STATUS, PHASES } from "../../../src/lib/memory-grid/constants";
import { viewerOutcome } from "../../../src/lib/results/viewerOutcome";
import Board from "./Board";
import { PORTAL_CONFIG } from "./portal-config";
import { PORTAL_RUNTIME } from "./portal-sdk";
import ResultScreen from "./ResultScreen";
import RoundResult from "./RoundResult";
import {
  createLocalMatch,
  submitReconstruction,
  tick,
  viewForMatch,
  type LocalMatch,
  type LocalMatchView,
  type SubmitFeedback,
} from "./match";
import { randomSeed } from "./seed";

/** How often the match advances and the countdown re-paints. */
const TICK_MS = 100;

/** The bot's name in this build. It is not a signed-in player. */
const BOT_NAME = "GRYND AI";

/** The whole match as mm:ss — the result screen's only timing line. */
function matchTimeLabel(view: LocalMatchView): string {
  const start = Number(view.startedAtMs) || 0;
  const end = Number(view.endedAtMs ?? view.startedAtMs) || start;
  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

/** The phase banner's label — the primary reading of the screen. */
function phaseLabel(view: LocalMatchView): string {
  if (view.status === MATCH_STATUS.READY) return "Get ready";
  if (view.status === MATCH_STATUS.FINISHED) {
    if (view.viewerOutcome === "win") return "You win!";
    if (view.viewerOutcome === "loss") return "You lose";
    return "Draw";
  }
  if (view.phase === PHASES.MEMORIZE) return "Memorize";
  if (view.phase === PHASES.RECONSTRUCT) {
    if (view.playerSubmitted) return "Submitted. Waiting";
    if (view.botSubmitted) return "Finish your grid";
    return "Recreate the pattern";
  }
  return "…";
}

/** The countdown in the banner's corner. */
function countdownLabel(view: LocalMatchView): string | null {
  if (view.msLeft === null) return null;
  if (view.phase === PHASES.MEMORIZE) return `${(view.msLeft / 1000).toFixed(1)}s`;
  return `${Math.ceil(view.msLeft / 1000)}s`;
}

export default function App() {
  const [match, setMatch] = useState<LocalMatch | null>(null);
  const [difficulty, setDifficulty] = useState<AiDifficulty>("normal");
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState<number[]>([]);
  const [feedback, setFeedback] = useState<SubmitFeedback | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The handlers must see the newest match without re-binding on every tick.
  const matchRef = useRef<LocalMatch | null>(null);
  useEffect(() => {
    matchRef.current = match;
  }, [match]);

  const view = useMemo(() => (match ? viewForMatch(match, now) : null), [match, now]);

  const start = useCallback((tier: AiDifficulty) => {
    setDifficulty(tier);
    matchRef.current = null;
    setMatch(null);
    setSelected([]);
    setFeedback(null);
    setNotice(null);
    setError(null);
    lastRoundRef.current = null;

    try {
      const created = createLocalMatch({
        difficulty: tier,
        seed: randomSeed(),
        nowMs: Date.now(),
      });
      matchRef.current = created;
      setMatch(created);
      setNow(Date.now());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the match.");
    }
  }, []);

  const backToMenu = useCallback(() => {
    matchRef.current = null;
    setMatch(null);
    setSelected([]);
    setFeedback(null);
    setNotice(null);
    lastRoundRef.current = null;
  }, []);

  // ── The clock ──────────────────────────────────────────────────────────
  // Runs only while a match is live; a finished match is inert (the controller
  // refuses to advance one), so there is nothing to tick.
  const running = Boolean(match && !match.result);
  useEffect(() => {
    if (!running) return undefined;
    const id = window.setInterval(() => {
      const stamp = Date.now();
      setNow(stamp);
      setMatch((prev) => (prev && !prev.result ? tick(prev, stamp) : prev));
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [running]);

  // ── Portal lifecycle ───────────────────────────────────────────────────
  // A complete no-op in every default build; when a portal build enables an SDK,
  // a blocked or dead CDN can only fail quietly and the game continues (see
  // src/portal-sdk.ts).
  useEffect(() => {
    PORTAL_RUNTIME.boot();
    const id = window.setTimeout(() => PORTAL_RUNTIME.loaded(), 0);
    return () => window.clearTimeout(id);
  }, []);

  // gameplayStart/gameplayStop around a live match, and one celebration on a
  // win. Keyed on the match's identity and result, not on the object, so the
  // 100 ms tick does not re-fire it.
  useEffect(() => {
    if (!match) {
      PORTAL_RUNTIME.leaveMatch();
      return;
    }
    if (!match.result) {
      PORTAL_RUNTIME.enterMatch();
      return;
    }
    PORTAL_RUNTIME.leaveMatch();
    if (viewerOutcome({ result: match.result, viewerSeat: "player1" }) === "win") {
      PORTAL_RUNTIME.celebrate();
    }
  }, [match?.seed, match?.result]);

  // ── A new round clears the player's picks and their feedback ───────────
  const roundNumber = view?.roundNumber ?? null;
  const lastRoundRef = useRef<number | null>(null);
  useEffect(() => {
    if (roundNumber === null) return;
    if (lastRoundRef.current === roundNumber) return;
    lastRoundRef.current = roundNumber;
    setSelected([]);
    setFeedback(null);
    setNotice(null);
  }, [roundNumber]);

  // ── Tile interaction ───────────────────────────────────────────────────
  // Tapping a blank tile flips it face-up and selects it; tapping it again
  // flips it back. There is NO pick limit — over-selection is penalised by the
  // full-grid scoring, and the grid never shows whether a pick is correct.
  const canPick = Boolean(
    view &&
      view.status === MATCH_STATUS.ACTIVE &&
      view.phase === PHASES.RECONSTRUCT &&
      !view.playerSubmitted,
  );

  const toggleTile = useCallback(
    (index: number) => {
      if (!canPick) return;
      setSelected((prev) =>
        prev.includes(index) ? prev.filter((value) => value !== index) : [...prev, index],
      );
    },
    [canPick],
  );

  const submit = useCallback(() => {
    const current = matchRef.current;
    if (!current) return;
    const outcome = submitReconstruction(current, selected, Date.now());
    if (outcome.error) {
      setNotice(outcome.error);
      return;
    }
    setNotice(null);
    setFeedback(outcome.feedback);
    matchRef.current = outcome.match;
    setMatch(outcome.match);
    setNow(Date.now());
  }, [selected]);

  const finished = view?.status === MATCH_STATUS.FINISHED;
  const roundResult =
    view && view.phase === PHASES.RESULT && view.rounds.length > 0
      ? view.rounds[view.rounds.length - 1]
      : null;

  return (
    <div className="min-h-screen w-full bg-[radial-gradient(80%_60%_at_50%_-10%,#12213f_0%,#080d1a_55%,#04070f_100%)] text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-3 pb-16 pt-5 sm:px-5 lg:max-w-5xl">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-[clamp(17px,2.4vw,22px)] font-black uppercase tracking-[0.16em]">
              Memory<span className="text-amber-400">Grid</span>
            </h1>
            <p className="mt-0.5 text-[10px] uppercase tracking-[0.2em] text-white/40">
              Study the pattern · rebuild it from memory
            </p>
          </div>

          {match && !finished ? (
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-white/15 bg-white/5 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-white/70">
                {AI_DIFFICULTY_LABELS[match.difficulty]}
              </span>
              <button
                type="button"
                onClick={backToMenu}
                data-testid="back-to-menu"
                className="gr-focusable rounded-full border border-white/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-white/60 transition hover:border-white/30 hover:text-white"
              >
                Menu
              </button>
            </div>
          ) : null}
        </header>

        <main className="mt-3 flex flex-1 flex-col">
          {!match || !view ? (
            <Menu difficulty={difficulty} onPick={setDifficulty} onStart={start} error={error} />
          ) : roundResult ? (
            <div className="mx-auto mt-4 w-full max-w-3xl">
              <RoundResult view={view} round={roundResult} botName={BOT_NAME} />
            </div>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center justify-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-500/10 px-3 py-1 text-xs font-black uppercase tracking-widest text-amber-300">
                  {view.isTiebreak ? (
                    <>
                      Tiebreak <span className="text-yellow-300">{view.roundNumber}</span>
                    </>
                  ) : (
                    <>
                      Round <span className="text-yellow-300">{view.roundNumber}</span>/
                      {view.roundsPerMatch}
                    </>
                  )}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/30 px-3 py-1 text-xs font-bold text-white/60">
                  {view.gridSize}×{view.gridSize} · {view.activeCount} lit
                </span>
              </div>

              {/* Desktop side rail: the round tracker and the scoreboard move
                  beside the board from `lg` up, freeing the height they used to
                  occupy above it so the square board can grow. */}
              <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-start lg:gap-6">
                <div className="lg:order-2 lg:col-start-2 lg:row-start-1 lg:flex lg:flex-col lg:gap-3">
                  <div className="mb-3 flex justify-center rounded-2xl border border-cyan-700/30 bg-black/30 px-4 py-3">
                    <RoundDots
                      total={view.roundsPerMatch}
                      myWins={view.p1Score}
                      oppWins={view.p2Score}
                    />
                  </div>

                  <div className="mb-4 grid grid-cols-2 gap-3">
                    <ScoreCard
                      label="You"
                      tone="amber"
                      total={view.p1Total}
                      roundWins={view.p1Score}
                      thisRound={view.p1RoundScore}
                      submitted={view.playerSubmitted}
                      highlighted={canPick}
                    />
                    <ScoreCard
                      label={BOT_NAME}
                      tone="cyan"
                      total={view.p2Total}
                      roundWins={view.p2Score}
                      thisRound={view.p2RoundScore}
                      submitted={view.botSubmitted}
                      highlighted={false}
                    />
                  </div>
                </div>

                <div className="lg:order-1 lg:col-start-1 lg:row-start-1">
                  {/* Phase banner — the primary reading of the screen. */}
                  <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm">
                    <div className="flex min-w-0 items-center gap-2">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                        className="h-4 w-4 flex-shrink-0 text-amber-300"
                      >
                        <path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
                        <path d="M18 16l.9 2.1L21 19l-2.1.9L18 22l-.9-2.1L15 19l2.1-.9z" />
                      </svg>
                      <span
                        aria-live="polite"
                        data-testid="phase-label"
                        className={`truncate font-black uppercase tracking-[0.2em] ${
                          view.phase === PHASES.MEMORIZE && !finished
                            ? "text-lg text-amber-300"
                            : "text-white/75"
                        }`}
                      >
                        {phaseLabel(view)}
                      </span>
                    </div>
                    {view.msLeft !== null && !finished ? (
                      <div
                        role="timer"
                        data-testid="countdown"
                        className={`flex items-center gap-1.5 font-mono text-lg font-bold tabular-nums ${
                          view.msLeft <= 5000 ? "text-red-400" : "text-amber-300"
                        }`}
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.75"
                          strokeLinecap="round"
                          aria-hidden
                          className="h-4 w-4"
                        >
                          <circle cx="12" cy="12" r="8" />
                          <path d="M12 8v4l3 2" />
                        </svg>
                        {countdownLabel(view)}
                      </div>
                    ) : null}
                  </div>

                  {notice ? (
                    <div
                      role="status"
                      className="mb-4 rounded-lg border border-red-400/40 bg-red-900/30 px-3 py-2 text-sm text-red-200"
                    >
                      {notice}
                    </div>
                  ) : null}

                  {feedback && view.phase === PHASES.RECONSTRUCT ? (
                    <div className="mb-4 rounded-xl border border-emerald-500/40 bg-emerald-950/40 px-4 py-3 text-center text-sm">
                      <span className="font-bold text-emerald-300">
                        Round score {feedback.score}
                      </span>
                      <span className="ml-1 text-white/50">
                        · {feedback.correct} of {feedback.total} cells (
                        {feedback.accuracyPct}%) ·{" "}
                        {(feedback.completionTimeMs / 1000).toFixed(2)}s
                      </span>
                    </div>
                  ) : null}

                  {view.phase === PHASES.RECONSTRUCT && view.playerSubmitted && !view.botSubmitted ? (
                    <div className="mb-4 rounded-xl border border-amber-400/40 bg-amber-950/30 px-4 py-3 text-center text-sm">
                      <span className="font-bold text-amber-300">Waiting for opponent…</span>
                      <span className="ml-1 text-white/50">your grid is locked</span>
                    </div>
                  ) : null}

                  {view.phase === PHASES.RECONSTRUCT && !view.playerSubmitted && view.botSubmitted ? (
                    <div className="mb-4 rounded-xl border border-cyan-400/40 bg-cyan-950/30 px-4 py-3 text-center text-sm">
                      <span className="font-bold text-cyan-300">Opponent submitted</span>
                      <span className="ml-1 text-white/50">
                        Finish your grid and press Submit
                      </span>
                    </div>
                  ) : null}

                  <Board
                    size={view.gridSize}
                    active={view.patternVisible && view.pattern ? view.pattern.active : []}
                    picks={selected}
                    revealed={Boolean(finished)}
                    interactive={canPick}
                    onToggle={toggleTile}
                    label="Memory Grid tiles"
                  />

                  {canPick ? (
                    <div className="mx-auto mt-4 flex w-full max-w-lg flex-wrap items-center justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => setSelected([])}
                        disabled={selected.length === 0}
                        data-testid="clear-picks"
                        className="gr-focusable rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs font-bold text-white/70 transition hover:bg-white/10 disabled:opacity-40"
                      >
                        Clear
                      </button>
                      <span className="text-center text-xs text-white/45">
                        {selected.length} selected · {view.activeCount} lit this round
                      </span>
                      <button
                        type="button"
                        onClick={submit}
                        data-testid="submit-picks"
                        className="gr-focusable rounded-xl border-b-4 border-amber-700 bg-amber-500 px-6 py-2 text-sm font-extrabold text-black transition hover:brightness-110"
                      >
                        Submit
                      </button>
                    </div>
                  ) : null}

                  {finished ? (
                    <ResultScreen
                      view={view}
                      botName={BOT_NAME}
                      durationLabel={matchTimeLabel(view)}
                      cta={PORTAL_CONFIG}
                      onReplay={() => start(match.difficulty)}
                      onChangeDifficulty={backToMenu}
                    />
                  ) : null}
                </div>
              </div>
            </>
          )}
        </main>

        <p className="mt-5 text-center text-[10px] uppercase tracking-wider text-white/30">
          No account · no network · nothing saved
        </p>
      </div>

      {/* Ready takeover: the 3 s countdown between "Start" and round 1. */}
      {view && view.status === MATCH_STATUS.READY ? (
        <div className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-[#04070f]/80">
          <div className="text-center">
            <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/50">
              Same pattern · {AI_DIFFICULTY_LABELS[match.difficulty]} bot
            </p>
            <p className="mt-2 text-6xl font-black tabular-nums">
              {Math.max(1, Math.ceil((view.msLeft ?? 0) / 1000))}
            </p>
            <p className="mt-1 text-[10px] uppercase tracking-[0.24em] text-white/40">Get ready</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Small presentational pieces ─────────────────────────────────────────

function Menu({
  difficulty,
  onPick,
  onStart,
  error,
}: {
  difficulty: AiDifficulty;
  onPick: (tier: AiDifficulty) => void;
  onStart: (tier: AiDifficulty) => void;
  error: string | null;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center py-6">
      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-white/[0.03] p-5 text-center">
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-amber-400">
          Memory duel
        </p>
        <h2 className="mt-2 text-2xl font-black leading-tight">
          Study the lit tiles. Rebuild the pattern.
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-white/60">
          Five rounds, and the grid grows as it gets harder: 3×3 → 5×5, then a 6×6
          tiebreak if the totals finish level. Each round lights a handful of tiles for
          a few seconds — then they go dark and you tap the ones you remember.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-white/60">
          Your round score is your accuracy over the whole grid, so guessing every tile
          costs you. The bot plays the same grids at the same time.
        </p>

        <div className="mt-5 grid grid-cols-3 gap-2">
          {AI_DIFFICULTIES.map((tier) => {
            const active = difficulty === tier;
            return (
              <button
                key={tier}
                type="button"
                onClick={() => onPick(tier)}
                aria-pressed={active}
                data-testid={`difficulty-${tier}`}
                className={`gr-focusable rounded-xl border px-2 py-1.5 text-xs font-black uppercase tracking-wider transition ${
                  active
                    ? "border-amber-400 bg-amber-400/15 text-white"
                    : "border-white/15 bg-white/[0.02] text-white/60 hover:border-white/30"
                }`}
              >
                {AI_DIFFICULTY_LABELS[tier]}
              </button>
            );
          })}
        </div>

        <p className="mt-2 text-[10px] leading-snug text-white/35">
          Difficulty sets how much of each pattern the bot recalls.
        </p>

        <button
          type="button"
          onClick={() => onStart(difficulty)}
          data-testid="start-match"
          className="gr-focusable mt-4 w-full rounded-xl bg-amber-500 px-4 py-3 text-sm font-black uppercase tracking-[0.18em] text-black transition hover:brightness-110"
        >
          Start match
        </button>

        {error ? (
          <p className="mt-3 rounded-xl border border-red-400/40 bg-red-950/40 p-3 text-sm text-red-200">
            {error}
          </p>
        ) : null}

        <p className="mt-3 text-[10px] uppercase tracking-wider text-white/30">
          No account · no coins · nothing saved
        </p>
      </div>
    </div>
  );
}

function ScoreCard({
  label,
  tone,
  total,
  roundWins,
  thisRound,
  submitted,
  highlighted,
}: {
  label: string;
  tone: "amber" | "cyan";
  total: number;
  roundWins: number;
  thisRound: number;
  submitted: boolean;
  highlighted: boolean;
}) {
  const border = highlighted
    ? "border-amber-400/70 bg-amber-500/10 shadow-[0_0_20px_rgba(251,191,36,0.15)]"
    : submitted
      ? tone === "amber"
        ? "border-emerald-400/60 bg-emerald-500/10"
        : "border-cyan-400/70 bg-cyan-500/10"
      : "border-white/10 bg-black/30";

  return (
    <div className={`rounded-2xl border p-3 text-center transition ${border}`}>
      <p className="text-[10px] font-bold uppercase tracking-widest text-white/50">
        {label}
        {submitted ? <span className="ml-1.5 text-emerald-300">✓</span> : null}
      </p>
      <p
        className={`mt-0.5 text-3xl font-black tabular-nums ${
          tone === "amber" ? "text-yellow-300" : "text-cyan-300"
        }`}
      >
        {total}
      </p>
      <p className="text-[10px] font-bold uppercase tracking-widest text-white/40">pts</p>
      <p className="mt-0.5 text-[10px] text-white/40">
        {roundWins} round win{roundWins === 1 ? "" : "s"} · {thisRound} this round
      </p>
    </div>
  );
}

/** Best-of-N round tracker: blue = you, red = the bot, dim = undecided. */
function RoundDots({
  total,
  myWins,
  oppWins,
}: {
  total: number;
  myWins: number;
  oppWins: number;
}) {
  const decided = myWins + oppWins;
  return (
    <div
      className="flex items-center gap-1.5"
      role="img"
      aria-label={`Best of ${total}. You won ${myWins}, the bot won ${oppWins}`}
    >
      {Array.from({ length: total }, (_, index) => {
        const mine = index < myWins;
        const theirs = !mine && index < decided;
        return (
          <span
            key={index}
            data-dot={mine ? "win" : theirs ? "loss" : "open"}
            className={`inline-block h-3.5 w-3.5 rounded-full border sm:h-4 sm:w-4 ${
              mine
                ? "border-blue-200 bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.9)]"
                : theirs
                  ? "border-red-200 bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.9)]"
                  : "border-white/20 bg-white/5"
            }`}
          />
        );
      })}
    </div>
  );
}

