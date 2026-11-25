"use client";

// src/components/play/PuzzleSessionPlayer.tsx
//
// THE PLAY SURFACE FOR BOTH PUZZLE MODES.
//
// Puzzle Ranked and Puzzle vs AI share one board component and one session
// protocol: the browser renders the server's projected board, proposes a move,
// and then shows the server's answer. It never owns a start state, a stock
// order, a solved count, a clock or a result.
//
//   GET  /api/solitaire-puzzle/session/<id>         the viewer's own board
//   POST /api/solitaire-puzzle/session/<id>/move    one move, then a verdict
//   POST /api/solitaire-puzzle/session/<id>/forfeit  ranked only
//
// The board is the shipped `SolitaireBoard`, so drag, click-to-place, keyboard
// play, themes and cosmetics behave exactly as they do in the other modes. The
// component adds only what a puzzle race needs: the objective, its measurable
// progress, both solved counts, the shared countdown, the post-move verdict,
// and the settled result with the viewer's own rating/trophy deltas.
//
// Polling is deliberate: practice bots are advanced on server reads, and a
// ranked opponent's progress only arrives that way. A finished session stops
// polling, and no client value can move the score.

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconArrowLeft, IconClock, IconTrophy } from "@tabler/icons-react";

import Footer from "../Footer";
import NavigationBar from "../navigation-bar";
import SolitaireBoard from "../solitaire-duel/SolitaireBoard";
import GlitchSay from "../mascot/GlitchSay";
import CompetitiveStreakResultBadge from "../profil/CompetitiveStreakResultBadge";
import { useTranslation } from "../../hooks/useTranslation";
import {
  PUZZLE_BOARD_POLL_MS,
  formatPuzzleClock,
  puzzleOutcomeKey,
  puzzleProgressPercent,
  puzzleRemainingMs,
  puzzleVerdictKey,
  reconcilePuzzleView,
  type PuzzleMoveVerdict,
} from "../../lib/solitaire-puzzle/boardView";
// The route's public projection, imported as a TYPE only: the client bundle
// still receives nothing but what the route serialized.
import type { PuzzleSessionView } from "../../lib/solitaire-puzzle/types";
import type { SolitaireMove } from "../../lib/solitaire-duel/types";

type MoveVerdict = PuzzleMoveVerdict;

export default function PuzzleSessionPlayer({
  sessionId,
  mode,
  opponentName = null,
  onRestart,
  onChooseBot,
  onPlayAgain,
  onBackToLobby,
}: {
  sessionId: string;
  mode: "ranked" | "ai";
  opponentName?: string | null;
  /** Practice only: start another session with the same bot. */
  onRestart?: () => void;
  /** Practice only: return to the picker. */
  onChooseBot?: () => void;
  /** Ranked only: leave the settled race and open a fresh search. */
  onPlayAgain?: () => void;
  /** Ranked only: drop the settled race and show the lobby again. */
  onBackToLobby?: () => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<PuzzleSessionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // A poll that fails after a board is on screen is a reconnect, not a fatal
  // load error: the player keeps the last authoritative board and is told.
  const [connectionLost, setConnectionLost] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [verdict, setVerdict] = useState<MoveVerdict>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [confirmingForfeit, setConfirmingForfeit] = useState(false);
  const [forfeiting, setForfeiting] = useState(false);
  const [tick, setTick] = useState(0);
  const offsetRef = useRef(0);
  const hasBoardRef = useRef(false);
  // One expiry read per session, so a clock at 0:00 cannot spam the API.
  const expiryReadRef = useRef(false);
  const resultHeadingRef = useRef<HTMLHeadingElement | null>(null);

  const applyView = useCallback((next: PuzzleSessionView | null) => {
    if (!next) return;
    // Keep the newest server offset even when this snapshot is stale.
    offsetRef.current = Math.max(offsetRef.current, next.serverNowMs - Date.now());
    hasBoardRef.current = true;
    // A poll in flight during a move can resolve after it; the newer board
    // must win, and a settled result must never revert to a live board.
    setView((current) => reconcilePuzzleView(current, next));
  }, []);

  const read = useCallback(async () => {
    try {
      const res = await fetch(`/api/solitaire-puzzle/session/${sessionId}`, {
        cache: "no-store",
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) {
        if (hasBoardRef.current) setConnectionLost(true);
        else setLoadError(true);
        return null;
      }
      setLoadError(false);
      setConnectionLost(false);
      applyView(body.data as PuzzleSessionView);
      return body.data as PuzzleSessionView;
    } catch {
      if (hasBoardRef.current) setConnectionLost(true);
      else setLoadError(true);
      return null;
    } finally {
      setLoading(false);
    }
  }, [applyView, sessionId]);

  useEffect(() => {
    setLoading(true);
    setView(null);
    setLoadError(false);
    setConnectionLost(false);
    hasBoardRef.current = false;
    expiryReadRef.current = false;
    offsetRef.current = 0;
    void read();
  }, [read]);

  // Ranked opponent progress and the practice bot both arrive on reads.
  useEffect(() => {
    if (!view || view.status !== "playing") return;
    const id = setInterval(() => {
      void read();
    }, PUZZLE_BOARD_POLL_MS);
    return () => clearInterval(id);
  }, [read, view?.status]);

  // One local second, for the shared countdown only.
  useEffect(() => {
    if (!view?.deadlineAtMs || view.status !== "playing") return;
    const id = setInterval(() => setTick((value) => value + 1), 1_000);
    return () => clearInterval(id);
  }, [view?.deadlineAtMs, view?.status]);

  // A solve hands the NEXT board back in the same move response. Clearing the
  // previous verdict the instant the puzzle number changes keeps the new
  // position immediately playable instead of carrying the old "solved" line
  // (and any old error) into it.
  useEffect(() => {
    setVerdict(null);
    setMoveError(null);
  }, [view?.puzzleNumber]);

  useEffect(() => {
    if (view?.status === "finished") resultHeadingRef.current?.focus();
  }, [view?.status]);

  const live =
    view?.status === "playing" && Boolean(view.board) && !submitting;

  const play = useCallback(
    async (move: SolitaireMove) => {
      if (!view || view.status !== "playing" || submitting) return;
      setSubmitting(true);
      setMoveError(null);
      setVerdict(null);
      try {
        const res = await fetch(
          `/api/solitaire-puzzle/session/${sessionId}/move`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // The seat's own cursor: a stale tab is refused server-side instead
            // of applying a move the player made on an old board.
            body: JSON.stringify({ move, expectedPly: view.ply }),
          },
        );
        const body = await res.json().catch(() => null);

        // The board only proposes legal moves; a 422 means the position moved
        // under us, so nothing was judged and nothing was spent.
        if (res.status === 422) {
          setVerdict("illegal");
          await read();
          return;
        }
        if (res.status === 409) {
          const stale = /stale/i.test(String(body?.error ?? ""));
          setMoveError(
            t(
              stale
                ? "playHub.lobby.puzzleBoard.stale"
                : "playHub.lobby.puzzleBoard.ended",
            ),
          );
          await read();
          return;
        }
        if (!res.ok || !body?.success) {
          setMoveError(t("playHub.lobby.puzzleBoard.loadError"));
          return;
        }
        applyView(body.data.session as PuzzleSessionView);
        setVerdict((body.data.moveStatus ?? null) as MoveVerdict);
      } catch {
        setMoveError(t("playHub.lobby.puzzleBoard.loadError"));
      } finally {
        setSubmitting(false);
      }
    },
    [applyView, read, sessionId, submitting, t, view],
  );

  const forfeit = useCallback(async () => {
    setForfeiting(true);
    setMoveError(null);
    try {
      const res = await fetch(
        `/api/solitaire-puzzle/session/${sessionId}/forfeit`,
        { method: "POST" },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) {
        setMoveError(t("playHub.lobby.puzzleBoard.loadError"));
        return;
      }
      applyView(body.data as PuzzleSessionView);
      setConfirmingForfeit(false);
    } catch {
      setMoveError(t("playHub.lobby.puzzleBoard.loadError"));
    } finally {
      setForfeiting(false);
    }
  }, [applyView, sessionId, t]);

  const remainingMs = puzzleRemainingMs(
    view?.puzzleDeadlineAtMs ?? view?.deadlineAtMs ?? null,
    offsetRef.current,
    Date.now(),
  );
  // `tick` is read so the countdown re-renders every second.
  void tick;

  // The deadline is enforced by the server; this read is what asks it to
  // finalize a match nobody moved in. It runs at most once per session.
  useEffect(() => {
    if (view?.status !== "playing" || remainingMs == null || remainingMs > 0) {
      return;
    }
    if (expiryReadRef.current) return;
    expiryReadRef.current = true;
    void read();
  }, [read, remainingMs, view?.status]);

  const verdictKey = puzzleVerdictKey(verdict);

  const outcome = view?.result ?? null;
  const draw = outcome ? outcome.winnerSeat === null : false;
  const won = outcome ? outcome.winnerSeat === view?.seat : false;
  const outcomeKey = puzzleOutcomeKey(view);
  const reasonKey =
    outcome?.resolutionReason === "deadline"
      ? "resolutionDeadline"
      : outcome?.resolutionReason === "forfeit"
        ? "resolutionForfeit"
        : outcome?.resolutionReason === "draw"
          ? "resolutionDraw"
          : outcome?.resolutionReason === "lives"
            ? "resolutionLives"
            : outcome?.resolutionReason === "finish"
              ? "resolutionFinish"
              : null;
  const pct = puzzleProgressPercent(view?.progress);

  // The settled scoreboard, always from the server's own result payload.
  const mySolved = outcome
    ? view?.seat === "player1"
      ? outcome.player1.solved
      : outcome.player2.solved
    : view?.solvedCount ?? 0;
  const theirSolved = outcome
    ? view?.seat === "player1"
      ? outcome.player2.solved
      : outcome.player1.solved
    : view?.opponentSolvedCount ?? 0;
  const opponentLabel =
    mode === "ranked"
      ? outcome?.opponentName ?? t("playHub.lobby.puzzleBoard.human")
      : opponentName ?? t("playHub.lobby.puzzleBoard.ai");
  // Ranked has no "same opponent" rematch: play again re-enters the queue.
  const playAgainAction = mode === "ranked" ? onPlayAgain : onRestart ?? onPlayAgain;
  const backToLobbyAction = onBackToLobby ?? onChooseBot;

  const glitchMessage = outcome
    ? won
      ? "You took the match. Clean line."
      : draw
        ? "A draw — neither seat solved enough in time."
        : "That one got away. The next board is a fresh race."
    : verdict === "illegal"
      ? "That move is not legal here."    : verdict === "no-progress"
      ? "Legal, but it does not move the objective — that costs a life."
    : view?.status === "playing"
          ? "Find the line that moves the objective."
          : "Waiting for the race to start.";

  return (
    <div className="relative min-h-dvh overflow-hidden bg-[color:var(--bg-page)] pb-24 text-[color:var(--text-primary)] md:pb-0">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(ellipse_at_top,rgba(94,234,212,0.12),transparent_62%)]"
      />
      <NavigationBar currentPath="/play" />

      <div className="relative mx-auto max-w-6xl px-4 pt-6 sm:px-6 md:pt-8">
        <Link
          href={mode === "ranked" ? "/play/puzzle-ranked" : "/play/puzzle-ai"}
          className="inline-flex items-center gap-2 text-xs font-bold text-white/55 underline-offset-4 transition hover:text-white hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[#5eead4]"
        >
          <IconArrowLeft size={15} aria-hidden="true" />
          {mode === "ranked"
            ? t("playHub.lobby.puzzleBoard.backRanked")
            : t("playHub.lobby.puzzleBoard.backAi")}
        </Link>

        <header className="mt-4 flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[11px] font-black uppercase tracking-[0.24em] text-[#5eead4]/85">
              {mode === "ranked"
                ? t("playHub.lobby.puzzleBoard.rankedKicker")
                : t("playHub.lobby.puzzleBoard.aiKicker")}
            </p>
            <h1 className="mt-1 text-2xl font-black tracking-tight sm:text-3xl">
              {view
                ? t("playHub.lobby.puzzleBoard.puzzleNumber", {
                    number: view.puzzleNumber,
                  })
                : t("playHub.lobby.puzzleBoard.loading")}
            </h1>
            <p className="mt-1 text-xs text-white/55">
              {mode === "ranked"
                ? t("playHub.lobby.puzzleBoard.human")
                : opponentName
                  ? `${opponentName} · ${t("playHub.lobby.puzzleBoard.ai")}`
                  : t("playHub.lobby.puzzleBoard.ai")}
            </p>
            <p
              data-testid="puzzle-battle-rules"
              className="mt-1 text-[11px] font-bold uppercase tracking-[0.1em] text-[#5eead4]/70"
            >
              {t("playHub.lobby.puzzleBoard.battleRules")}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span
              data-testid="puzzle-lives"
              className="inline-flex items-center gap-1.5 rounded-xl border border-rose-300/30 bg-rose-300/10 px-3 py-2 text-xs font-black text-rose-100"
            >
              <span aria-hidden="true">♥</span>
              {t("playHub.lobby.puzzleBoard.lives")} {view?.lives ?? 3}
            </span>
            <span
              data-testid="puzzle-opponent-lives"
              className="inline-flex items-center gap-1.5 rounded-xl border border-white/12 bg-white/[0.04] px-3 py-2 text-xs font-bold text-white/65"
            >
              <span aria-hidden="true">♥</span>
              {t("playHub.lobby.puzzleBoard.opponentLives")} {view?.opponentLives ?? 3}
            </span>
            {mode === "ai" && (
              <span className="rounded-xl border border-[#c4b5fd]/30 bg-[#c4b5fd]/10 px-3 py-2 text-xs font-bold text-[#ede9fe]">
                {t("playHub.lobby.puzzleBoard.untimed")}
              </span>
            )}
            {mode === "ranked" &&
              (remainingMs != null ? (
                <span
                  data-testid="puzzle-session-clock"
                  className="inline-flex items-center gap-1.5 rounded-xl border border-white/12 bg-white/[0.04] px-3 py-2 font-mono text-sm font-bold text-white"
                >
                  <IconClock size={15} aria-hidden="true" className="text-[#5eead4]" />
                  {formatPuzzleClock(remainingMs)}
                </span>
              ) : (
                <span className="rounded-xl border border-white/12 bg-white/[0.04] px-3 py-2 text-xs font-bold text-white/60">
                  {t("playHub.lobby.puzzleBoard.untimed")}
                </span>
              ))}
            <span className="inline-flex items-center gap-1.5 rounded-xl border border-white/12 bg-white/[0.04] px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-white/65">
              {t("playHub.lobby.puzzleBoard.you")} {view?.solvedCount ?? 0} /{" "}
              {view?.puzzleCount ?? 0}
              <span aria-hidden="true" className="text-white/25">
                ·
              </span>
              {t("playHub.lobby.puzzleBoard.opponent")}{" "}
              {view?.opponentSolvedCount ?? 0} / {view?.puzzleCount ?? 0}
            </span>
          </div>
        </header>

        {connectionLost && view && (
          <p
            role="status"
            aria-live="polite"
            data-testid="puzzle-session-reconnecting"
            className="mt-4 rounded-lg border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-xs text-amber-100"
          >
            {t("playHub.lobby.puzzleBoard.reconnecting")}
          </p>
        )}

        {loading && (
          <p aria-busy="true" className="py-16 text-center text-sm text-white/45">
            {t("playHub.lobby.puzzleBoard.loading")}
          </p>
        )}

        {loadError && !view && (
          <div
            role="alert"
            className="mt-5 rounded-xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-100"
          >
            <p>{t("playHub.lobby.puzzleBoard.loadError")}</p>
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                setLoadError(false);
                void read();
              }}
              className="mt-3 rounded-lg border border-rose-300/40 px-3 py-1.5 text-xs font-black uppercase tracking-[0.12em] text-rose-50 hover:bg-rose-300/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-200"
            >
              {t("playHub.lobby.puzzleBoard.retry")}
            </button>
          </div>
        )}

        {view?.status === "waiting" && !loadError && (
          <p className="mt-5 rounded-xl border border-white/10 bg-black/25 p-4 text-sm text-white/70">
            {t("playHub.lobby.puzzleBoard.waiting")}
          </p>
        )}

        {view?.board && (
          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
            <div className="min-w-0">
              <div
                data-testid="puzzle-session-objective"
                className="rounded-2xl border border-white/10 bg-white/[0.03] p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#5eead4]/80">
                      {t("playHub.lobby.puzzleBoard.objective")}
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-white/85">
                      {view.puzzle.objectiveText}
                    </p>
                  </div>
                  <p className="shrink-0 rounded-lg border border-white/10 bg-black/20 px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.1em] text-white/55">
                    {t("playHub.lobby.puzzleBoard.par")} {view.puzzle.par}
                  </p>
                </div>
                {view.progress.measurable && view.progress.target > 0 && (
                  <div className="mt-3">
                    <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-[0.12em] text-white/45">
                      <span>{t("playHub.lobby.puzzleBoard.progress")}</span>
                      <span className="font-mono text-white/70">
                        {view.progress.current} / {view.progress.target}
                      </span>
                    </div>
                    <div
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={view.progress.target}
                      aria-valuenow={view.progress.current}
                      aria-label={t("playHub.lobby.puzzleBoard.progress")}
                      className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10"
                    >
                      <div
                        className="h-full rounded-full bg-[#5eead4] transition-[width] duration-300 motion-reduce:transition-none"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-4">
                <SolitaireBoard
                  view={view.board}
                  interactive={live}
                  onMove={play}
                  onInvalid={() => setVerdict("illegal")}
                />
              </div>

              <p
                role="status"
                aria-live="polite"
                className={`mt-3 min-h-5 text-center text-xs ${
                  moveError
                    ? "text-rose-200"
                    : verdict === "illegal"
                      ? "text-rose-200"
                      : verdict === "no-progress"
                        ? "text-amber-200"
                        : "text-[#99f6e4]"
                }`}
              >
                {moveError ??
                  (submitting
                    ? t("playHub.lobby.puzzleBoard.checking")
                    : verdictKey
                      ? `${t(`playHub.lobby.puzzleBoard.${verdictKey}`)}${
                          verdict === "no-progress"
                            ? ` · ${t("playHub.lobby.puzzleBoard.lifeLost")}`
                            : ""
                        }`
                      : view.status === "playing"
                        ? t("playHub.lobby.puzzleBoard.yourTurn")
                        : "")}
              </p>
            </div>

            <aside className="space-y-3" aria-label={t("playHub.lobby.puzzleBoard.progress")}>
              <div className="rounded-2xl border border-[#5eead4]/25 bg-[#5eead4]/[0.06] p-3">
                <GlitchSay placement="inline" size="sm" message={glitchMessage} />
              </div>

              {mode === "ai" && (
                <div
                  data-testid="puzzle-ai-status"
                  aria-live="polite"
                  className="rounded-2xl border border-[#c4b5fd]/25 bg-[#c4b5fd]/[0.06] p-3"
                >
                  <p className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.16em] text-[#ddd6fe]">
                    {opponentName ?? t("playHub.lobby.puzzleBoard.ai")}
                    <span className="rounded-full border border-[#c4b5fd]/40 bg-[#c4b5fd]/10 px-1.5 py-0.5 text-[8px] tracking-[0.12em]">
                      {t("playHub.lobby.puzzleBoard.ai")}
                    </span>
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-white/70">
                    {view.status !== "finished"
                      ? t("playHub.lobby.puzzleBoard.aiThinking")
                      : view.opponentSolvedCount >= view.puzzleCount
                        ? t("playHub.lobby.puzzleBoard.aiSolved")
                        : t("playHub.lobby.puzzleBoard.aiNotSolved")}
                  </p>
                </div>
              )}

              <dl className="rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-xs">
                <div className="flex items-center justify-between gap-3 py-0.5">
                  <dt className="text-white/45">{t("playHub.lobby.puzzleBoard.puzzleOf", { number: view.puzzleNumber, total: view.puzzleCount })}</dt>
                  <dd className="font-mono font-bold text-white">
                    {view.puzzle.level}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 py-0.5">
                  <dt className="text-white/45">{t("playHub.lobby.puzzleBoard.you")}</dt>
                  <dd className="font-mono font-bold text-white">
                    {view.solvedCount} / {view.puzzleCount}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 py-0.5">
                  <dt className="text-white/45">{t("playHub.lobby.puzzleBoard.opponent")}</dt>
                  <dd className="font-mono font-bold text-white">
                    {view.opponentSolvedCount} / {view.puzzleCount}
                  </dd>
                </div>
              </dl>

              {mode === "ranked" && view.status === "playing" && (
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
                  {confirmingForfeit ? (
                    <div className="space-y-2">
                      <p className="text-xs text-white/70">
                        {t("playHub.lobby.puzzleBoard.forfeitAsk")}
                      </p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={forfeit}
                          disabled={forfeiting}
                          data-testid="puzzle-session-forfeit-confirm"
                          className="flex-1 rounded-lg border border-rose-300/40 bg-rose-300/10 px-2 py-1.5 text-[11px] font-black uppercase tracking-[0.12em] text-rose-100 hover:bg-rose-300/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-200 disabled:opacity-60"
                        >
                          {t("playHub.lobby.puzzleBoard.forfeitConfirm")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingForfeit(false)}
                          className="flex-1 rounded-lg border border-white/15 px-2 py-1.5 text-[11px] font-black uppercase tracking-[0.12em] text-white/65 hover:border-white/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60"
                        >
                          {t("playHub.lobby.puzzleBoard.forfeitCancel")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmingForfeit(true)}
                      data-testid="puzzle-session-forfeit"
                      className="w-full rounded-lg border border-white/15 px-2 py-2 text-[11px] font-black uppercase tracking-[0.12em] text-white/55 hover:border-rose-300/40 hover:text-rose-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-200"
                    >
                      {t("playHub.lobby.puzzleBoard.forfeit")}
                    </button>
                  )}
                </div>
              )}

              <Link
                href="/play"
                className="block text-center text-[11px] font-bold uppercase tracking-[0.12em] text-white/40 underline-offset-4 hover:text-white hover:underline"
              >
                {t("playHub.lobby.puzzleBoard.backPlay")}
              </Link>
            </aside>
          </div>
        )}
      </div>

      {/* THE RESULT POPUP.
          A settled race is announced over the finished board instead of in a
          card tucked into the side rail: the outcome, GLITCH, both verified
          scores, both lives totals and the opponent's name land together, and
          the only ways forward are play again and the lobby. */}
      {outcome && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="puzzle-session-popup-title"
          data-testid="puzzle-session-popup"
          className="fixed inset-0 z-[95] flex items-center justify-center overflow-y-auto bg-black/80 p-3 backdrop-blur-xs sm:p-4"
        >
          <div
            data-testid="puzzle-session-result"
            className={`relative w-full max-w-md overflow-hidden rounded-2xl border bg-[color:var(--bg-surface)] p-5 text-center shadow-[var(--shadow-raise)] sm:p-6 ${
              won
                ? "border-emerald-300/40"
                : draw
                  ? "border-[color:var(--border-strong)]"
                  : "border-rose-300/35"
            }`}
          >
            <div
              aria-hidden="true"
              className={`absolute inset-x-0 top-0 h-0.5 ${
                won ? "bg-emerald-300" : draw ? "bg-white/30" : "bg-rose-300"
              }`}
            />
            <p className="text-[11px] font-black uppercase tracking-[0.2em] text-[color:var(--text-muted)]">
              {mode === "ranked"
                ? t("playHub.lobby.puzzleBoard.rankedKicker")
                : t("playHub.lobby.puzzleBoard.aiKicker")}
            </p>
            <h2
              id="puzzle-session-popup-title"
              ref={resultHeadingRef}
              tabIndex={-1}
              className={`mt-2 text-2xl font-black tracking-tight focus-visible:outline-hidden sm:text-3xl ${
                won
                  ? "text-[color:var(--state-win)]"
                  : draw
                    ? "text-[color:var(--text-primary)]"
                    : "text-[color:var(--state-loss)]"
              }`}
            >
              {t(`playHub.lobby.puzzleBoard.${outcomeKey}`)}
            </h2>
            {reasonKey && (
              <p
                data-testid="puzzle-session-reason"
                className="mt-1 text-xs leading-relaxed text-[color:var(--text-secondary)]"
              >
                {t(`playHub.lobby.puzzleBoard.${reasonKey}`)}
              </p>
            )}

            <div className="mt-4 flex justify-center">
              <GlitchSay placement="inline" size="sm" message={glitchMessage} />
            </div>

            <div className="mt-5 grid grid-cols-2 gap-2 text-left">
              <div className="rounded-xl border border-[#5eead4]/30 bg-[#5eead4]/[0.07] p-3">
                <p className="text-[11px] font-black uppercase tracking-[0.16em] text-[#5eead4]">
                  {t("playHub.lobby.puzzleBoard.you")}
                </p>
                <p
                  data-testid="puzzle-popup-score-you"
                  className="mt-1 font-mono text-2xl font-black text-[color:var(--text-primary)]"
                >
                  {mySolved}
                  <span className="text-sm font-bold text-[color:var(--text-muted)]">
                    {" / "}
                    {view?.puzzleCount ?? 0}
                  </span>
                </p>
                <p
                  data-testid="puzzle-popup-lives"
                  className="mt-1 text-xs font-bold text-rose-400"
                >
                  <span aria-hidden="true">♥</span>{" "}
                  {t("playHub.lobby.puzzleBoard.lives")} {view?.lives ?? 0}
                </p>
              </div>
              <div className="min-w-0 rounded-xl border border-[color:var(--border-hairline)] bg-[color:var(--bg-panel)] p-3">
                <p
                  data-testid="puzzle-popup-opponent-name"
                  title={opponentLabel}
                  className="truncate text-[11px] font-black uppercase tracking-[0.16em] text-[color:var(--text-muted)]"
                >
                  {opponentLabel}
                </p>
                <p
                  data-testid="puzzle-popup-score-opponent"
                  className="mt-1 font-mono text-2xl font-black text-[color:var(--text-primary)]"
                >
                  {theirSolved}
                  <span className="text-sm font-bold text-[color:var(--text-muted)]">
                    {" / "}
                    {view?.puzzleCount ?? 0}
                  </span>
                </p>
                <p
                  data-testid="puzzle-popup-opponent-lives"
                  className="mt-1 text-xs font-bold text-[color:var(--text-secondary)]"
                >
                  <span aria-hidden="true">♥</span>{" "}
                  {t("playHub.lobby.puzzleBoard.lives")} {view?.opponentLives ?? 0}
                </p>
              </div>
            </div>

            {outcome.reward &&
              (outcome.reward.ratingDelta != null ||
                outcome.reward.trophiesDelta != null) && (
                <p className="mt-3 flex flex-wrap items-center justify-center gap-2 text-xs text-[color:var(--text-secondary)]">
                  <IconTrophy size={14} aria-hidden="true" />
                  {outcome.reward.ratingDelta != null && (
                    <span data-testid="puzzle-session-rating">
                      {t("playHub.lobby.puzzleBoard.rating", {
                        delta:
                          outcome.reward.ratingDelta > 0
                            ? `+${outcome.reward.ratingDelta}`
                            : String(outcome.reward.ratingDelta),
                      })}
                    </span>
                  )}
                  {outcome.reward.trophiesDelta != null && (
                    <span data-testid="puzzle-session-trophies">
                      {t("playHub.lobby.puzzleBoard.trophies", {
                        delta:
                          outcome.reward.trophiesDelta > 0
                            ? `+${outcome.reward.trophiesDelta}`
                            : String(outcome.reward.trophiesDelta),
                      })}
                    </span>
                  )}
                </p>
              )}

            {mode === "ranked" && (
              <div className="mt-3 flex justify-center">
                <CompetitiveStreakResultBadge gameKey="solitaire-puzzle" />
              </div>
            )}

            <div className="mx-auto mt-5 flex w-full max-w-xs flex-col gap-2">
              {playAgainAction && (
                <button
                  type="button"
                  onClick={playAgainAction}
                  data-testid="puzzle-popup-play-again"
                  className={`inline-flex w-full items-center justify-center rounded-lg px-4 py-2.5 text-sm font-black transition hover:brightness-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/70 ${
                    mode === "ranked"
                      ? "bg-[#5eead4] text-[#04120f]"
                      : "bg-[#c4b5fd] text-[#12081f]"
                  }`}
                >
                  {t("playHub.lobby.puzzleBoard.restart")}
                </button>
              )}
              {backToLobbyAction ? (
                <button
                  type="button"
                  onClick={backToLobbyAction}
                  data-testid="puzzle-popup-back-to-lobby"
                  className="inline-flex w-full items-center justify-center rounded-lg border border-[color:var(--border-strong)] px-4 py-2.5 text-sm font-bold text-[color:var(--text-primary)] transition hover:bg-[color:var(--bg-panel)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--focus-ring)]"
                >
                  {t("playHub.lobby.puzzleBoard.backLobby")}
                </button>
              ) : (
                <Link
                  href={
                    mode === "ranked" ? "/play/puzzle-ranked" : "/play/puzzle-ai"
                  }
                  data-testid="puzzle-popup-back-to-lobby"
                  className="inline-flex w-full items-center justify-center rounded-lg border border-[color:var(--border-strong)] px-4 py-2.5 text-sm font-bold text-[color:var(--text-primary)] transition hover:bg-[color:var(--bg-panel)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--focus-ring)]"
                >
                  {t("playHub.lobby.puzzleBoard.backLobby")}
                </Link>
              )}
            </div>
          </div>
        </div>
      )}

      <Footer />
    </div>
  );
}
