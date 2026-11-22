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
}: {
  sessionId: string;
  mode: "ranked" | "ai";
  opponentName?: string | null;
  /** Practice only: start another session with the same bot. */
  onRestart?: () => void;
  /** Practice only: return to the picker. */
  onChooseBot?: () => void;
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
    view?.deadlineAtMs ?? null,
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
          : outcome?.resolutionReason === "finish"
            ? "resolutionFinish"
            : null;
  const pct = puzzleProgressPercent(view?.progress);

  return (
    <div className="relative min-h-screen overflow-hidden bg-[color:var(--bg-page)] pb-24 text-[color:var(--text-primary)] md:pb-0">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(ellipse_at_top,rgba(94,234,212,0.12),transparent_62%)]"
      />
      <NavigationBar currentPath="/play" />

      <main className="relative mx-auto max-w-6xl px-4 pt-24 sm:px-6 md:pt-28">
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
            <p className="text-[10px] font-black uppercase tracking-[0.24em] text-[#5eead4]/85">
              {mode === "ranked"
                ? t("playHub.lobby.puzzleBoard.rankedKicker")
                : t("playHub.lobby.puzzleBoard.aiKicker")}
            </p>
            <h1 className="mt-1 text-2xl font-black tracking-tight sm:text-3xl">
              {view
                ? t("playHub.lobby.puzzleBoard.puzzleOf", {
                    number: view.puzzleNumber,
                    total: view.puzzleCount,
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
          </div>

          <div className="flex flex-wrap items-center gap-2">
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
                    <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#5eead4]/80">
                      {t("playHub.lobby.puzzleBoard.objective")}
                    </p>
                    <p className="mt-1 text-sm leading-relaxed text-white/85">
                      {view.puzzle.objectiveText}
                    </p>
                  </div>
                  <p className="shrink-0 rounded-lg border border-white/10 bg-black/20 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.1em] text-white/55">
                    {t("playHub.lobby.puzzleBoard.par")} {view.puzzle.par}
                  </p>
                </div>
                {view.progress.measurable && view.progress.target > 0 && (
                  <div className="mt-3">
                    <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.12em] text-white/45">
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
                      ? t(`playHub.lobby.puzzleBoard.${verdictKey}`)
                      : view.status === "playing"
                        ? t("playHub.lobby.puzzleBoard.yourTurn")
                        : "")}
              </p>
            </div>

            <aside className="space-y-3" aria-label={t("playHub.lobby.puzzleBoard.progress")}>
              {mode === "ai" && (
                <div
                  data-testid="puzzle-ai-status"
                  aria-live="polite"
                  className="rounded-2xl border border-[#c4b5fd]/25 bg-[#c4b5fd]/[0.06] p-3"
                >
                  <p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.16em] text-[#ddd6fe]">
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

              {outcome && (
                <div
                  data-testid="puzzle-session-result"
                  aria-live="polite"
                  className={`rounded-2xl border p-4 ${
                    won
                      ? "border-emerald-300/40 bg-emerald-300/10 text-emerald-50"
                      : draw
                        ? "border-white/15 bg-white/[0.04] text-white/80"
                        : "border-rose-300/30 bg-rose-300/10 text-rose-50"
                  }`}
                >
                  <h2
                    ref={resultHeadingRef}
                    tabIndex={-1}
                    className="text-sm font-black uppercase tracking-[0.14em] focus-visible:outline-hidden"
                  >
                    {t(`playHub.lobby.puzzleBoard.${outcomeKey}`)}
                  </h2>
                  <p className="mt-1 font-mono text-xs opacity-80">
                    {outcome.player1.solved} — {outcome.player2.solved}
                  </p>
                  {reasonKey && (
                    <p
                      data-testid="puzzle-session-reason"
                      className="mt-1 text-[11px] leading-relaxed opacity-85"
                    >
                      {t(`playHub.lobby.puzzleBoard.${reasonKey}`)}
                    </p>
                  )}
                  {outcome.reward &&
                    (outcome.reward.ratingDelta != null ||
                      outcome.reward.trophiesDelta != null) && (
                      <p className="mt-2 flex flex-wrap items-center gap-2 text-xs">
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
                  <div className="mt-3 flex flex-wrap gap-2">
                    {mode === "ai" && onRestart && (
                      <button
                        type="button"
                        onClick={onRestart}
                        data-testid="puzzle-session-restart"
                        className="rounded-lg bg-[#c4b5fd] px-3 py-2 text-xs font-black text-[#12081f] hover:brightness-110 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/70"
                      >
                        {t("playHub.lobby.puzzleBoard.restart")}
                      </button>
                    )}
                    {mode === "ai" && onChooseBot && (
                      <button
                        type="button"
                        onClick={onChooseBot}
                        data-testid="puzzle-session-choose"
                        className="rounded-lg border border-[#c4b5fd]/45 bg-[#c4b5fd]/10 px-3 py-2 text-xs font-bold text-[#ede9fe] hover:bg-[#c4b5fd]/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c4b5fd]"
                      >
                        {t("playHub.lobby.puzzleBoard.chooseBot")}
                      </button>
                    )}
                    <Link
                      href={
                        mode === "ranked" ? "/play/puzzle-ranked" : "/play/puzzle-ai"
                      }
                      className="rounded-lg border border-white/15 px-3 py-2 text-xs font-bold text-white/70 hover:border-white/30 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60"
                    >
                      {mode === "ranked"
                        ? t("playHub.lobby.puzzleBoard.backRanked")
                        : t("playHub.lobby.puzzleBoard.backAi")}
                    </Link>
                  </div>
                </div>
              )}

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
                          className="flex-1 rounded-lg border border-rose-300/40 bg-rose-300/10 px-2 py-1.5 text-[10px] font-black uppercase tracking-[0.12em] text-rose-100 hover:bg-rose-300/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-200 disabled:opacity-60"
                        >
                          {t("playHub.lobby.puzzleBoard.forfeitConfirm")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingForfeit(false)}
                          className="flex-1 rounded-lg border border-white/15 px-2 py-1.5 text-[10px] font-black uppercase tracking-[0.12em] text-white/65 hover:border-white/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/60"
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
                      className="w-full rounded-lg border border-white/15 px-2 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-white/55 hover:border-rose-300/40 hover:text-rose-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-200"
                    >
                      {t("playHub.lobby.puzzleBoard.forfeit")}
                    </button>
                  )}
                </div>
              )}

              <Link
                href="/play"
                className="block text-center text-[10px] font-bold uppercase tracking-[0.12em] text-white/40 underline-offset-4 hover:text-white hover:underline"
              >
                {t("playHub.lobby.puzzleBoard.backPlay")}
              </Link>
            </aside>
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}
