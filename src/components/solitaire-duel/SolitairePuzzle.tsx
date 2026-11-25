"use client";

// src/components/solitaire-duel/SolitairePuzzle.tsx
//
// THE PUZZLE — a real Klondike board, played by hand, coached by Glitch.
//
// There are no multiple-choice buttons any more. The browser receives a
// playable `SolitaireView` of a real mid-game position taken from a verified
// winning deal, and the player moves a card exactly as they would in a game:
// drag it (or a face-up run) onto a pile, click it then click the target, or
// click the stock to turn the next waste card over.
//
// Every click goes through `SolitaireBoard` → `interactions.ts` → the engine's
// own validators, so a move this component sends is a move the server accepts.
// The parent sends it and renders the server's verdict; it never decides the
// answer, and the answer is not in the initial payload.
//
// Glitch sits in the side column and explains the verdict with facts: what the
// best move does, which card it uncovers when it does, and why what was played
// was not the strongest choice. The answer is the position's unique best move,
// not necessarily a card-revealing one. After the move is judged the board shows
// the position AFTER the best move, the way a chess puzzle shows the solution.
//
// OFFLINE: the unlimited puzzle is still playable with no network — it is built
// and checked locally with the same pure verifier — and nothing is recorded.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import SolitaireBoard from "./SolitaireBoard";
import GlitchSay from "../mascot/GlitchSay";
import { isOfflineError } from "../../hooks/useOnlineStatus";
import {
  buildOfflinePuzzle,
  publicPuzzle,
  randomPuzzleSeed,
  verifyPuzzleMove,
  type PublicPuzzle,
  type Puzzle,
  type PuzzleReveal,
} from "../../lib/solitaire-duel/puzzleCore";
import {
  puzzleCardText,
  puzzleFeedback,
  puzzleMoveText,
} from "../../lib/solitaire-duel/puzzleFeedback";
import type { SolitaireMove, SolitaireView } from "../../lib/solitaire-duel/types";
import type { GlitchExpression } from "../../lib/mascot/glitchAssets";

type Allowance = {
  unlimited: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
  dayKey: string;
  resetsAt: string;
};

type Attempt = {
  correct: boolean;
  move?: SolitaireMove | null;
  answeredAt?: string | null;
} | null;

type DailyStep = PublicPuzzle & { step: number; totalSteps: number };

type PuzzleData = PublicPuzzle & {
  attempt?: Attempt;
  answerMove?: SolitaireMove | null;
  answerReveal?: PuzzleReveal | null;
  solution?: SolitaireView | null;
  allowance?: Allowance | null;
  step?: number;
  totalSteps?: number;
  status?: "playing" | "failed" | "completed";
  nextStep?: DailyStep | null;
};

/** One judged move: what was played, what wins, and the board after it. */
type Judgement = {
  correct: boolean;
  playedMove: SolitaireMove;
  answer: SolitaireMove;
  answerReveal: PuzzleReveal | null;
  solution: SolitaireView | null;
};

type GlitchLine = { expression: GlitchExpression; message: string };

type Props = { kind: "daily" | "unlimited" };

const OPENING_LINE =
  "Your move. Find the strongest move on the board — drag a card, or click it and then click where it goes. You can click the stock to draw.";

const OFFLINE_LINE =
  "No connection, so this one is built on your device. Same rules, same board — nothing is saved.";

function hiddenCards(board: SolitaireView | null | undefined): number {
  let count = 0;
  for (const column of board?.tableau ?? []) {
    for (const slot of column) if (!slot.faceUp) count += 1;
  }
  return count;
}

export default function SolitairePuzzle({ kind }: Props) {
  const [puzzle, setPuzzle] = useState<PuzzleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [limitReached, setLimitReached] = useState(false);
  const [judgement, setJudgement] = useState<Judgement | null>(null);
  // The next board of a daily run, unlocked by a correct answer.
  const [nextStep, setNextStep] = useState<DailyStep | null>(null);
  // A solved practice puzzle may be replayed ONCE for free: the server judges
  // the same position again without taking a slot from the day's allowance.
  const [replayMode, setReplayMode] = useState(false);
  const [replayed, setReplayed] = useState(false);
  // True when this position was built in the tab because there is no network.
  const [offline, setOffline] = useState(false);
  const [line, setLine] = useState<GlitchLine>({
    expression: "focused",
    message: OPENING_LINE,
  });
  const [lineVersion, setLineVersion] = useState(0);
  // The local puzzle's answer. It never leaves this component, and nothing
  // derived from it is stored.
  const localRef = useRef<Puzzle | null>(null);

  const announce = useCallback((next: GlitchLine) => {
    setLine(next);
    setLineVersion((version) => version + 1);
  }, []);

  /** The verdict, in Glitch's words, from the engine's facts. */
  const announceJudgement = useCallback(
    (judged: Judgement, before: SolitaireView | null) => {
      const feedback = puzzleFeedback({
        correct: judged.correct,
        playedMove: judged.playedMove,
        answer: judged.answer,
        answerReveal: judged.answerReveal,
        board: before,
      });
      announce({
        expression: judged.correct ? "victory" : "defeat",
        message: feedback.body,
      });
    },
    [announce],
  );

  // The unlimited puzzle is the offline-capable mode: a position is a pure
  // function of a seed, so the tab can build and check one with no network.
  // The daily puzzle is tied to the server's UTC day and its one recorded
  // move, so it stays online-only.
  const buildLocal = useCallback(() => {
    const local = buildOfflinePuzzle(randomPuzzleSeed());
    localRef.current = local;
    setPuzzle({ ...publicPuzzle(local), attempt: null, allowance: null });
    setOffline(true);
  }, []);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setFailed(false);
      setLimitReached(false);
      setJudgement(null);
      setNextStep(null);
      setReplayMode(false);
      setReplayed(false);
      setOffline(false);
      localRef.current = null;
      announce({ expression: "focused", message: OPENING_LINE });

      // Offline: never even attempt the request. The yield paints "Dealing…"
      // before the synchronous deal search runs.
      if (
        kind === "unlimited" &&
        typeof navigator !== "undefined" &&
        navigator.onLine === false
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        try {
          buildLocal();
          announce({ expression: "focused", message: OFFLINE_LINE });
        } catch {
          setFailed(true);
        } finally {
          setLoading(false);
        }
        return;
      }

      try {
        const response = await fetch(`/api/solitaire/puzzle?kind=${kind}`, {
          credentials: "same-origin",
          cache: "no-store",
          signal,
        });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body?.success) throw new Error(body?.error || "Puzzle unavailable");
        const data = body.data as PuzzleData;
        setPuzzle(data);

        // A daily puzzle that has already been played resumes on its solution:
        // the board shows the position after the best move, locked.
        if (data.attempt && data.answerMove) {
          const judged: Judgement = {
            correct: Boolean(data.attempt.correct),
            playedMove: data.attempt.move ?? data.answerMove,
            answer: data.answerMove,
            answerReveal: data.answerReveal ?? null,
            solution: data.solution ?? null,
          };
          setJudgement(judged);
          announceJudgement(judged, data.board);
        }
      } catch (error) {
        if ((error as Error)?.name === "AbortError") return;
        // A dropped connection or captive portal: build a local practice
        // puzzle instead of showing a dead card. Nothing is submitted.
        if (
          kind === "unlimited" &&
          (isOfflineError(error) ||
            (typeof navigator !== "undefined" && navigator.onLine === false))
        ) {
          try {
            buildLocal();
            announce({ expression: "focused", message: OFFLINE_LINE });
          } catch {
            setFailed(true);
          }
        } else {
          setFailed(true);
        }
      } finally {
        setLoading(false);
      }
    },
    [announce, announceJudgement, buildLocal, kind],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const allowance = puzzle?.allowance ?? null;
  const remaining = allowance?.unlimited ? null : allowance?.remaining ?? null;
  const outOfPuzzles = kind === "unlimited" && remaining === 0;

  const board: SolitaireView | null = judgement?.solution ?? puzzle?.board ?? null;
  const interactive =
    Boolean(puzzle) &&
    !loading &&
    !failed &&
    !judgement &&
    !limitReached &&
    !submitting &&
    !outOfPuzzles;

  /**
   * A move proposed by the BOARD. `SolitaireBoard` only proposes moves the
   * engine accepts, so this is already legal; the server still re-checks it
   * against its own position before judging or recording anything.
   */
  const play = useCallback(
    async (move: SolitaireMove) => {
      if (!puzzle || submitting || judgement || limitReached || outOfPuzzles) return;

      // OFFLINE: judge with the same pure verifier and record NOTHING. No
      // request is attempted, and no attempt or allowance is written anywhere.
      if (offline) {
        const local = localRef.current;
        if (!local) return;
        const judged: Judgement = {
          correct: verifyPuzzleMove(local, move),
          playedMove: move,
          answer: local.answer,
          answerReveal: local.answerReveal,
          solution: local.answerBoard,
        };
        setJudgement(judged);
        announceJudgement(judged, local.board);
        // Offline nothing is recorded, so the second look is free anyway.
        if (replayMode) {
          setReplayMode(false);
          setReplayed(true);
        }
        return;
      }

      setSubmitting(true);
      try {
        const response = await fetch("/api/solitaire/puzzle", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            key: puzzle.key,
            move,
            // Practice only: the free second look at a solved position.
            ...(kind === "unlimited" ? { replay: replayMode } : {}),
          }),
        });
        const body = await response.json().catch(() => null);

        if (response.status === 429) {
          if (body?.data?.allowance) {
            setPuzzle((current) =>
              current ? { ...current, allowance: body.data.allowance } : current,
            );
          }
          setLimitReached(true);
          announce({
            expression: "focused",
            message:
              "You have used all five free puzzles today. GRYND PRO plays them without a limit.",
          });
          return;
        }

        // The board only proposes engine-legal moves, so a 422 means the
        // position moved under us — nothing was judged and nothing was spent.
        if (response.status === 422) {
          announce({
            expression: "surprised",
            message:
              "That move is not legal in this position, so nothing was judged. Pick a card and a pile that accepts it.",
          });
          return;
        }

        if (response.status === 409) {
          if (body?.code === "PUZZLE_REPLAY_USED") {
            setReplayMode(false);
            setReplayed(true);
            announce({
              expression: "focused",
              message:
                "This position has already had its one free replay. Start a new puzzle instead.",
            });
            return;
          }
          announce({
            expression: "focused",
            message:
              body?.code === "PUZZLE_REPLAY_UNAVAILABLE"
                ? "Only a position you have already solved can be replayed."
                : "That step is still locked. Solve the earlier steps of today's puzzle first.",
          });
          return;
        }

        if (!response.ok || !body?.success) throw new Error(body?.error || "Move failed");

        const data = body.data as {
          correct: boolean;
          playedMove?: SolitaireMove | null;
          answer: SolitaireMove;
          answerReveal?: PuzzleReveal | null;
          solution?: SolitaireView | null;
          allowance?: Allowance | null;
          step?: number;
          totalSteps?: number;
          status?: "playing" | "failed" | "completed";
          nextStep?: DailyStep | null;
          replay?: boolean;
          replayAvailable?: boolean;
        };

        const judged: Judgement = {
          correct: Boolean(data.correct),
          playedMove: data.playedMove ?? move,
          answer: data.answer,
          answerReveal: data.answerReveal ?? null,
          solution: data.solution ?? null,
        };
        setJudgement(judged);
        setNextStep(data.nextStep ?? null);
        setReplayMode(false);
        if (data.replay) setReplayed(true);
        announceJudgement(judged, puzzle.board);
        if (data.allowance) {
          setPuzzle((current) =>
            current ? { ...current, allowance: data.allowance ?? null } : current,
          );
        }
      } catch {
        setFailed(true);
      } finally {
        setSubmitting(false);
      }
    },
    [
      puzzle,
      submitting,
      judgement,
      limitReached,
      outOfPuzzles,
      offline,
      kind,
      replayMode,
      announce,
      announceJudgement,
    ],
  );

  /** Move from a solved step to the next board the server unlocked. */
  const advance = useCallback(() => {
    const next = nextStep;
    if (!next) return;
    setPuzzle((current) =>
      current
        ? {
            ...current,
            key: next.key,
            kind: next.kind,
            dateKey: next.dateKey,
            board: next.board,
            step: next.step,
            totalSteps: next.totalSteps,
            attempt: null,
            answerMove: null,
            answerReveal: null,
            solution: null,
            nextStep: null,
          }
        : current,
    );
    setJudgement(null);
    setNextStep(null);
    announce({
      expression: "focused",
      message: `Step ${next.step} of ${next.totalSteps}. ${OPENING_LINE}`,
    });
  }, [announce, nextStep]);

  /**
   * Re-open the SAME practice position for its one free replay.
   *
   * Clearing the judgement puts the original board back (the solution board is
   * only shown while a judgement is held), and `replayMode` makes the next
   * submission ask the server not to spend a slot.
   */
  const startReplay = useCallback(() => {
    if (kind !== "unlimited" || !judgement?.correct || replayed || replayMode) return;
    setJudgement(null);
    setReplayMode(true);
    announce({
      expression: "focused",
      message:
        "Same position, one free replay — this does not use one of today's puzzles. Play the best move again.",
    });
  }, [announce, judgement, kind, replayed, replayMode]);

  const onInvalid = useCallback(
    (message: string) => {
      announce({ expression: "surprised", message });
    },
    [announce],
  );

  const feedback = judgement
    ? puzzleFeedback({
        correct: judgement.correct,
        playedMove: judgement.playedMove,
        answer: judgement.answer,
        answerReveal: judgement.answerReveal,
        board: puzzle?.board ?? null,
      })
    : null;

  const wasteTop = puzzle?.board.waste?.[puzzle.board.waste.length - 1] ?? null;
  const currentStep = puzzle?.step ?? 1;
  const totalSteps = puzzle?.totalSteps ?? 1;
  const title = kind === "daily" ? "Daily puzzle" : "Unlimited puzzle";
  const blurb =
    kind === "daily"
      ? "Three real positions from one verified winning deal, free for everyone. Find the best move at each step — one mistake ends the run."
      : "Real positions from verified winning deals, one move each — shorter than the daily run. Play the strongest move on the board; it may uncover a card, build a run, reach the foundation or draw.";

  return (
    <section
      aria-labelledby={`puzzle-${kind}-heading`}
      className="rounded-3xl border border-cyan-400/25 bg-gradient-to-b from-surface to-surface p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.3em] text-cyan-300/80">
            {kind === "daily"
              ? `GRYND · free · step ${currentStep} of ${totalSteps}`
              : "GRYND · practice"}
          </p>
          <h2
            id={`puzzle-${kind}-heading`}
            className="mt-1 text-2xl font-black tracking-tight text-white sm:text-3xl"
          >
            {title}
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-white/55">{blurb}</p>
        </div>

        {kind === "unlimited" && offline && (
          <div className="rounded-xl border border-amber-300/30 bg-amber-400/10 px-3 py-2 text-right">
            <p className="text-[11px] font-black uppercase tracking-[0.18em] text-amber-200/80">
              Offline
            </p>
            <p className="font-mono text-lg text-white">Unlimited</p>
            <p className="text-[11px] uppercase tracking-[0.12em] text-amber-100/50">not saved</p>
          </div>
        )}

        {kind === "unlimited" && !offline && allowance && (
          <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-right">
            {allowance.unlimited ? (
              <>
                <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#f5ff3b]">
                  GRYND PRO
                </p>
                <p className="font-mono text-lg text-white">Unlimited</p>
              </>
            ) : (
              <>
                <p className="text-[11px] font-black uppercase tracking-[0.18em] text-white/40">
                  Today
                </p>
                <p className="font-mono text-lg text-white">
                  {remaining}/{allowance.limit} left
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {loading && (
        <p className="py-10 text-center text-sm text-white/45" aria-busy="true">
          Dealing a verified position…
        </p>
      )}

      {failed && (
        <div className="mt-4 rounded-xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-100">
          {kind === "daily"
            ? "The daily puzzle needs a connection — it is tied to the server's UTC day."
            : "The puzzle could not be loaded. Please try again."}
        </div>
      )}

      {puzzle && !loading && (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start">
          <div className="min-w-0">
            <SolitaireBoard
              view={board}
              interactive={interactive}
              onMove={play}
              onInvalid={onInvalid}
            />
            {submitting && (
              <p className="mt-2 text-center text-[11px] font-semibold text-cyan-200/70" role="status">
                Checking that move…
              </p>
            )}
          </div>

          {/* Glitch, on the side: why that move was right, or why it was not. */}
          <aside className="space-y-3 lg:sticky lg:top-24" aria-label="Glitch explains the puzzle">
            <div className="rounded-2xl border border-cyan-400/20 bg-surface p-3">
              <GlitchSay
                key={lineVersion}
                expression={line.expression}
                message={line.message}
                placement="inline"
                size="sm"
              />
            </div>

            {feedback && (
              <div
                role="status"
                aria-live="polite"
                data-testid="puzzle-feedback"
                data-correct={judgement?.correct ? "true" : "false"}
                className={`rounded-2xl border p-3 text-sm ${
                  judgement?.correct
                    ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-50"
                    : "border-rose-400/30 bg-rose-400/10 text-rose-50"
                }`}
              >
                <p
                  className={`text-[11px] font-black uppercase tracking-[0.18em] ${
                    judgement?.correct ? "text-emerald-300" : "text-rose-300"
                  }`}
                >
                  {feedback.title}
                </p>
                <p
                  className={`mt-1 leading-relaxed ${
                    judgement?.correct ? "text-emerald-200" : "text-rose-200"
                  }`}
                >
                  {feedback.body}
                </p>
                {judgement && (
                  <p
                    className={`mt-2 text-xs ${
                      judgement.correct ? "text-emerald-200/80" : "text-rose-200/80"
                    }`}
                  >
                    Best move: <strong className="text-white">{puzzleMoveText(judgement.answer)}</strong>
                    {judgement.answerReveal
                      ? ` — it uncovers the ${puzzleCardText(judgement.answerReveal.card)} in column ${judgement.answerReveal.column + 1}.`
                      : "."}
                  </p>
                )}
                {offline && (
                  <p className="mt-1 text-xs text-white/45">
                    Checked on this device — nothing was recorded.
                  </p>
                )}
                {kind === "unlimited" && replayMode && (
                  <p className="mt-2 text-xs font-semibold text-cyan-200/85">
                    Free replay — no puzzle is spent on this attempt.
                  </p>
                )}
                {kind === "unlimited" && judgement && !replayed && (
                  <button
                    type="button"
                    onClick={startReplay}
                    data-testid="puzzle-replay"
                    className="mt-3 w-full rounded-lg border border-cyan-300/45 bg-cyan-300/10 px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-cyan-100 transition hover:bg-cyan-300/20"
                  >
                    {judgement.correct
                      ? "Replay this position once · free →"
                      : "Study the position again · free →"}
                  </button>
                )}
                {kind === "daily" && nextStep && (
                  <button
                    type="button"
                    onClick={advance}
                    data-testid="puzzle-next-step"
                    className="mt-3 w-full rounded-lg border border-emerald-300/50 bg-emerald-300/15 px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-emerald-100 transition hover:bg-emerald-300/25"
                  >
                    Next step · {currentStep + 1} of {totalSteps} →
                  </button>
                )}
                {kind === "daily" && judgement && (
                  <p
                    className={`mt-2 text-xs ${
                      judgement.correct ? "text-emerald-200/70" : "text-rose-200/70"
                    }`}
                  >
                    {judgement.correct
                      ? nextStep
                        ? `Step ${currentStep} of ${totalSteps} solved.`
                        : `All ${totalSteps} steps solved — daily complete.`
                      : `Run over at step ${currentStep} of ${totalSteps}. A new run arrives at UTC midnight.`}
                  </p>
                )}
                {/* A judged puzzle is a result: a practice position is done the
                    moment it is graded, and the daily run ends on its last
                    step or its first mistake. Either way the player leaves the
                    mode through the same Back to lobby exit the solo and bot
                    arena popups offer — a daily step that unlocked the next
                    board keeps playing and gets no exit. */}
                {judgement && (kind === "unlimited" || !nextStep) && (
                  <Link
                    href="/play"
                    data-testid="puzzle-back-to-lobby"
                    className="mt-3 inline-flex w-full items-center justify-center rounded-lg border border-white/15 px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-white/60 transition hover:border-white/30 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-300"
                  >
                    Back to lobby
                  </Link>
                )}
              </div>
            )}

            <dl className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-xs">
              <div className="flex items-center justify-between gap-3 py-0.5">
                <dt className="text-white/45">Face-down cards</dt>
                <dd className="font-mono font-bold text-white">
                  {hiddenCards(puzzle.board)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 py-0.5">
                <dt className="text-white/45">Stock</dt>
                <dd className="font-mono font-bold text-white">{puzzle.board.stockCount}</dd>
              </div>
              <div className="flex items-center justify-between gap-3 py-0.5">
                <dt className="text-white/45">Waste</dt>
                <dd className="font-mono font-bold text-white">
                  {wasteTop ? puzzleCardText(wasteTop) : "—"}
                </dd>
              </div>
            </dl>

            {kind === "unlimited" ? (
              <button
                type="button"
                onClick={() => load()}
                disabled={loading || submitting || outOfPuzzles}
                className="w-full rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-cyan-200 transition hover:bg-cyan-400/20 disabled:opacity-40"
              >
                New puzzle
              </button>
            ) : (
              <Link
                href="/daily"
                className="block w-full rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-3 py-2 text-center text-xs font-black uppercase tracking-[0.14em] text-cyan-200 transition hover:bg-cyan-400/20"
              >
                Play today's challenge →
              </Link>
            )}

            <p className="text-[11px] leading-relaxed text-white/35">
              {offline
                ? "Offline · unlimited practice, nothing saved"
                : kind === "unlimited" && allowance?.unlimited
                  ? "PRO · no daily limit"
                  : kind === "unlimited"
                    ? `Free plan · ${remaining ?? 0} of ${allowance?.limit ?? 5} left today`
                    : "Three official steps per UTC day. One mistake ends the run."}
            </p>
          </aside>
        </div>
      )}

      {/* THE DAILY RESULT POPUP.
          A daily run is over on its last solved step or its first mistake.
          That result now lands over the finished board, like the ranked and
          practice puzzle popups: GLITCH, the run's verified progress and a way
          back to the lobby. There is deliberately NO play-again control — a UTC
          day has one official run. */}
      {kind === "daily" && judgement && !nextStep && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="daily-puzzle-result-title"
          data-testid="daily-puzzle-result-popup"
          className="fixed inset-0 z-[95] flex items-center justify-center overflow-y-auto bg-black/80 p-3 backdrop-blur-xs sm:p-4"
        >
          <div
            className={`relative w-full max-w-md overflow-hidden rounded-2xl border bg-surface p-5 text-center shadow-2xl sm:p-6 ${
              judgement.correct ? "border-emerald-300/40" : "border-rose-300/35"
            }`}
          >
            <div
              aria-hidden="true"
              className={`absolute inset-x-0 top-0 h-0.5 ${
                judgement.correct ? "bg-emerald-300" : "bg-rose-300"
              }`}
            />
            <p className="text-[11px] font-black uppercase tracking-[0.2em] text-white/45">
              Daily puzzle
            </p>
            <h2
              id="daily-puzzle-result-title"
              tabIndex={-1}
              className={`mt-2 text-2xl font-black tracking-tight focus-visible:outline-hidden sm:text-3xl ${
                judgement.correct ? "text-emerald-300" : "text-rose-300"
              }`}
            >
              {judgement.correct ? "Daily complete" : "Run over"}
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-white/60">
              {judgement.correct
                ? `All ${totalSteps} steps solved. A new run arrives at UTC midnight.`
                : `The run ended at step ${currentStep} of ${totalSteps}. A new run arrives at UTC midnight.`}
            </p>

            <div className="mt-4 flex justify-center">
              <GlitchSay placement="inline" size="sm" message={line.message} />
            </div>

            <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.04] p-3 text-left">
              <p className="text-[11px] font-black uppercase tracking-[0.16em] text-white/40">
                Steps solved
              </p>
              <p className="mt-1 font-mono text-2xl font-black text-white">
                {judgement.correct ? totalSteps : Math.max(0, currentStep - 1)}
                <span className="text-sm font-bold text-white/45"> / {totalSteps}</span>
              </p>
            </div>

            <div className="mx-auto mt-5 w-full max-w-xs">
              <Link
                href="/play/daily-puzzle"
                data-testid="daily-puzzle-result-lobby"
                className="inline-flex w-full items-center justify-center rounded-lg border border-white/20 bg-white/[0.06] px-4 py-2.5 text-sm font-bold text-white transition hover:border-white/40 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
              >
                Back to lobby
              </Link>
            </div>
          </div>
        </div>
      )}

      {outOfPuzzles && !judgement && (
        <div className="mt-4 rounded-xl border border-[#f5ff3b]/30 bg-[#f5ff3b]/10 p-4 text-sm text-[#f7ffa1]">
          <p className="font-black">You have used all 5 free puzzles today.</p>
          <p className="mt-1 text-white/60">
            GRYND PRO plays unlimited puzzles, all day, every day.
          </p>
          <Link
            href="/upgrade-pro"
            className="mt-3 inline-flex rounded-lg border border-[#f5ff3b]/50 bg-[#f5ff3b]/15 px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-[#f5ff3b] hover:bg-[#f5ff3b]/25"
          >
            Go unlimited →
          </Link>
        </div>
      )}
    </section>
  );
}
