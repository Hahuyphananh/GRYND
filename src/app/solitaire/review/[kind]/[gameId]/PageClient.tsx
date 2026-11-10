"use client";

// src/app/solitaire/review/[kind]/[gameId]/PageClient.tsx
//
// GAME REVIEW — a read-only replay of a completed Solitaire game.
//
// The ONLY game data on this page comes from the Phase 3 review API:
//   duel  GET /api/solitaire-duel/match/<id>/review   (participant only)
//   solo  GET /api/solitaire/review?mode=solo&id=…    (Clerk or guest owner)
//   daily GET /api/solitaire/review?mode=daily&id=…
//
// Nothing here can change the game: the board is rendered with
// `interactive={false}` inside a `pointer-events-none` wrapper, and the page
// never POSTs a move. The board at the selected step is rebuilt from the
// canonical deal and a PREFIX of the server's validated log — no board snapshot
// is kept per move. The analysis runs once per game in a Web Worker; changing
// the selected move only changes which prefix is replayed.

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEventHandler,
  type ReactNode,
} from "react";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconCards,
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
  IconClock,
  IconSparkles,
} from "@tabler/icons-react";

import Footer from "../../../../../components/Footer";
import GlitchSay from "../../../../../components/mascot/GlitchSay";
import NavigationBar from "../../../../../components/navigation-bar";
import SolitaireBoard from "../../../../../components/solitaire-duel/SolitaireBoard";
import { useSolitaireReviewAnalysis } from "../../../../../hooks/useSolitaireReviewAnalysis";
import { useTranslation } from "../../../../../hooks/useTranslation";
import { buildGlitchReviewReactions } from "../../../../../lib/mascot/glitchReview";
import { formatDuration } from "../../../../../lib/solitaire-duel/soloStats.js";
import type {
  ReviewGameKind,
  ReviewStatus,
  SolitaireReview,
} from "../../../../../lib/solitaire-duel/review";
import {
  accuracyPercent,
  describeMove,
  GAME_KIND_LABEL,
  ratingForMove,
  RATING_META,
  reconstructReviewPosition,
  STATUS_META,
  stepPly,
  summaryCounts,
  tagLabel,
  type ReviewNavigationAction,
} from "../../../../../lib/solitaire-duel/reviewView";

const NOOP = () => {};

function Shell({
  children,
  backHref,
  navPath,
  onKeyDown,
}: {
  children: ReactNode;
  backHref: string;
  navPath: string;
  onKeyDown: KeyboardEventHandler<HTMLElement>;
}) {
  return (
    <div className="relative min-h-screen bg-[#05070d] pb-24 text-white md:pb-0">
      <NavigationBar currentPath={navPath} />
      <main
        onKeyDown={onKeyDown}
        className="mx-auto max-w-7xl px-4 pt-24 sm:px-6 md:pt-28"
      >
        <Link
          href={backHref}
          className="inline-flex items-center gap-1.5 rounded-md text-xs font-semibold text-white/50 transition-colors hover:text-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 motion-reduce:transition-none"
        >
          <IconArrowLeft size={14} aria-hidden="true" />
          Back to the game
        </Link>
        {children}
      </main>
      <Footer />
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "text-white",
  testId,
}: {
  label: string;
  value: ReactNode;
  tone?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="rounded-xl border border-white/10 bg-black/25 px-3 py-2"
    >
      <dt className="text-[10px] font-bold uppercase tracking-wider text-white/40">{label}</dt>
      <dd className={`mt-0.5 font-mono text-xl font-black tabular-nums ${tone}`}>{value}</dd>
    </div>
  );
}

function StatusChip({ status }: { status: ReviewStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      data-testid="review-status"
      className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wider ${meta.chip}`}
    >
      {meta.label}
    </span>
  );
}

function NavButton({
  label,
  onClick,
  disabled,
  children,
  testId,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  children: ReactNode;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      data-testid={testId}
      className="inline-flex h-10 min-w-10 items-center justify-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 disabled:cursor-not-allowed disabled:opacity-30 motion-reduce:transition-none"
    >
      {children}
    </button>
  );
}

export default function SolitaireReviewPageClient({
  kind,
  gameId,
}: {
  kind: ReviewGameKind;
  gameId: string;
}) {
  const [data, setData] = useState<SolitaireReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPly, setSelectedPly] = useState(0);
  const { t } = useTranslation();
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const selectedRefKey = useRef<string | null>(null);

  const backHref =
    kind === "daily" ? "/daily" : kind === "duel" ? `/casino/solitaire-duel/${gameId}` : "/solitaire";
  const navPath = kind === "daily" ? "/daily" : "/solitaire";

  // ── The one read: the server's validated review payload ─────────────────
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    setSelectedPly(0);

    const url =
      kind === "duel"
        ? `/api/solitaire-duel/match/${encodeURIComponent(gameId)}/review`
        : `/api/solitaire/review?mode=${kind}&id=${encodeURIComponent(gameId)}`;

    fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok || !body?.success) {
          if (response.status === 401) throw new Error("Sign in to review this game.");
          if (response.status === 404)
            throw new Error("This game could not be found, or it is not yours.");
          if (response.status === 409)
            throw new Error(body?.error || "This game is not ready to review yet.");
          throw new Error(body?.error || "Unable to load this game review.");
        }
        if (!body?.data?.deal || !Array.isArray(body.data.moves)) {
          throw new Error("The review data is incomplete.");
        }
        return body.data as SolitaireReview;
      })
      .then((payload) => {
        if (!alive) return;
        setData(payload);
        setSelectedPly(0);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        if (cause instanceof Error && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : "Unable to load this game review.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [gameId, kind]);

  const moves = data?.moves ?? [];
  const totalMoves = moves.length;

  // ── One analysis per game. Never per selected move. ──────────────────────
  const analysisState = useSolitaireReviewAnalysis({
    enabled: Boolean(data),
    gameKey: data ? `${data.gameKind}:${data.gameId}` : null,
    deal: data?.deal ?? null,
    moves: data?.moves ?? null,
    // The review API returns the cached (or first-computed) analysis. When it
    // is there the worker is never started; a null value is the only path to
    // client-side analysis.
    initialAnalysis: data?.analysis ?? null,
  });
  const analysis = data ? analysisState.analysis ?? data.analysis ?? null : null;

  // ── GLITCH's reactions, one map per game ────────────────────────────────
  // Built from the engine's own analysis and memoised on it — never rebuilt
  // when the selected move changes. The map only contains eligible events, so
  // a Normal move has nothing to look up and therefore says nothing. Inline in
  // this panel, never the floating provider: the review is page content.
  const glitchReactions = useMemo(
    () =>
      buildGlitchReviewReactions({
        analysis,
        gameKey: data ? `${data.gameKind}:${data.gameId}` : null,
      }),
    [analysis, data],
  );

  // ── Reconstruct ONLY the selected position from the deal + log prefix ────
  const position = useMemo(
    () =>
      data ? reconstructReviewPosition(data.deal, data.moves, selectedPly) : null,
    [data, selectedPly],
  );
  const view = position?.ok ? position.view : null;

  const go = useCallback(
    (action: ReviewNavigationAction) => {
      setSelectedPly((current) => stepPly(current, totalMoves, action));
    },
    [totalMoves],
  );

  // Keyboard stepping is scoped to the review page, and never steals a key from
  // a text field. Home/End are also page-scroll keys, so they are prevented.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        go("previous");
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        go("next");
      } else if (event.key === "Home") {
        event.preventDefault();
        go("start");
      } else if (event.key === "End") {
        event.preventDefault();
        go("end");
      }
    },
    [go],
  );

  // Keep the selected timeline row visible without moving the whole page.
  useEffect(() => {
    if (selectedRefKey.current === `${selectedPly}`) return;
    selectedRefKey.current = `${selectedPly}`;
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedPly]);

  const currentMove = selectedPly > 0 ? moves[selectedPly - 1] : null;
  const currentRating = ratingForMove(analysis, selectedPly - 1);
  const currentMeta = currentRating ? RATING_META[currentRating] : null;
  const glitchReaction =
    selectedPly > 0 ? glitchReactions.get(selectedPly - 1) ?? null : null;

  const counts = summaryCounts(analysis);
  const accuracy = accuracyPercent({
    eligible: data?.analysisEligible ?? false,
    analysis,
  });
  const moments = analysis?.moments?.slice(0, 6) ?? [];
  const status = data?.status ?? "incomplete";
  const rejectedAt =
    position && "rejectedAt" in position ? position.rejectedAt : null;

  const accuracyNote = (() => {
    if (!data) return "Loading the move log…";
    if (data.status !== "complete") return "Not scored — this game was not completed.";
    if (analysisState.status === "analyzing") return "Analyzing the validated move log…";
    if (analysisState.status === "error" || !analysis) {
      return "Analysis unavailable — every move can still be reviewed.";
    }
    if (!analysis.complete) return "The replay did not reach a completed board.";
    return "Derived from average regret across the moves the engine could rate.";
  })();

  return (
    <Shell backHref={backHref} navPath={navPath} onKeyDown={onKeyDown}>
      <header className="mt-5 max-w-3xl">
        <p className="text-[11px] font-black uppercase tracking-[0.4em] text-cyan-300/80">
          GRYND · game review
        </p>
        <h1 className="mt-3 text-4xl font-black leading-[0.95] tracking-tight sm:text-5xl">
          Every move, <span className="text-cyan-300">replayed.</span>
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-white/55 sm:text-base">
          The exact deal and the validated move log, rebuilt one position at a time.
          Nothing you do here changes the original game.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-white/55">
          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 font-bold uppercase tracking-wider">
            {GAME_KIND_LABEL[kind]}
          </span>
          {data && (
            <>
              <StatusChip status={status} />
              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                {data.variant} · v{data.variantVersion}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                <IconCards size={12} aria-hidden="true" /> {totalMoves} moves
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                <IconClock size={12} aria-hidden="true" /> {formatDuration(data.durationMs)}
              </span>
            </>
          )}
        </div>
      </header>

      {loading && (
        <p
          data-testid="review-loading"
          aria-busy="true"
          className="mt-10 rounded-2xl border border-white/10 bg-white/[0.03] p-10 text-center text-sm text-white/50"
        >
          Rebuilding the game…
        </p>
      )}

      {!loading && error && (
        <div
          data-testid="review-error"
          role="alert"
          className="mt-8 rounded-2xl border border-rose-400/30 bg-rose-400/10 p-6 text-sm text-rose-100"
        >
          <p className="flex items-center gap-2 font-semibold">
            <IconAlertTriangle size={16} aria-hidden="true" /> Review unavailable
          </p>
          <p className="mt-2 text-rose-100/75">{error}</p>
        </div>
      )}

      {!loading && data && (
        <>
          {data.status !== "complete" && (
            <div
              data-testid="review-incomplete"
              className="mt-5 flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] px-4 py-3 text-sm text-amber-100/85"
            >
              <IconAlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <p>
                {data.status === "forfeit"
                  ? "This game ended in a forfeit. Every played move is shown, but completion accuracy is not scored."
                  : "This game ended before the board was solved. Every played move is shown, but completion accuracy is not scored."}
              </p>
            </div>
          )}

          <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
            {/* ── Board + navigation ─────────────────────────────────────── */}
            <section
              aria-label="Board review"
              className="min-w-0 rounded-2xl border border-white/10 bg-[#070b12]/85 p-3 shadow-[0_20px_60px_rgba(0,0,0,0.35)] sm:p-5"
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/40">
                    {selectedPly === 0
                      ? "Initial deal"
                      : `Move ${selectedPly} of ${totalMoves}`}
                  </p>
                  <p
                    data-testid="review-current-move"
                    className="mt-0.5 truncate text-sm font-semibold text-white"
                  >
                    {selectedPly === 0
                      ? "Start position"
                      : describeMove(currentMove?.move)}
                  </p>
                </div>
                {currentMeta ? (
                  <span
                    data-testid="review-current-rating"
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wider ${currentMeta.chip}`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${currentMeta.dot}`} aria-hidden="true" />
                    {currentMeta.label}
                  </span>
                ) : selectedPly > 0 ? (
                  <span className="text-[10px] font-bold uppercase tracking-wider text-white/35">
                    Not rated
                  </span>
                ) : null}
              </div>

              {position?.ok ? (
                <div
                  data-testid="review-board"
                  data-ply={position.state.ply}
                  data-completed={position.state.completed ? "true" : "false"}
                  className="pointer-events-none select-none"
                >
                  <SolitaireBoard
                    view={view}
                    interactive={false}
                    readOnly
                    onMove={NOOP}
                  />
                </div>
              ) : (
                <div
                  data-testid="review-replay-error"
                  role="alert"
                  className="rounded-xl border border-rose-400/30 bg-rose-400/10 p-6 text-sm text-rose-100"
                >
                  The stored move history could not be reconstructed
                  {rejectedAt != null ? ` (rejected at move ${rejectedAt + 1})` : ""}
                  .
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  <NavButton
                    label="First move — initial position"
                    testId="review-nav-first"
                    onClick={() => go("start")}
                    disabled={selectedPly === 0}
                  >
                    <IconChevronsLeft size={18} aria-hidden="true" />
                  </NavButton>
                  <NavButton
                    label="Previous move"
                    testId="review-nav-prev"
                    onClick={() => go("previous")}
                    disabled={selectedPly === 0}
                  >
                    <IconChevronLeft size={18} aria-hidden="true" />
                  </NavButton>
                  <NavButton
                    label="Next move"
                    testId="review-nav-next"
                    onClick={() => go("next")}
                    disabled={selectedPly >= totalMoves}
                  >
                    <IconChevronRight size={18} aria-hidden="true" />
                  </NavButton>
                  <NavButton
                    label="Last move — final position"
                    testId="review-nav-last"
                    onClick={() => go("end")}
                    disabled={selectedPly >= totalMoves}
                  >
                    <IconChevronsRight size={18} aria-hidden="true" />
                  </NavButton>
                </div>
                <p className="text-[10px] uppercase tracking-wider text-white/30">
                  ← → step · Home / End jump
                </p>
              </div>

              {/* Inline commentary: only for the moves the engine marked as
                  worth a line, and keyed by the stable event id so a revisit
                  rerenders that same reaction rather than a new one. */}
              {glitchReaction && (
                <div
                  data-testid="review-glitch"
                  data-glitch-move={glitchReaction.moveNumber}
                  className="mt-4"
                >
                  <GlitchSay
                    key={glitchReaction.eventId}
                    placement="inline"
                    expression={glitchReaction.expression}
                    message={t(glitchReaction.messageKey)}
                    eventId={glitchReaction.eventId}
                    priority={glitchReaction.priority}
                    size="sm"
                  />
                </div>
              )}
            </section>

            {/* ── Summary, moments, timeline ─────────────────────────────── */}
            <aside className="min-w-0 space-y-4" aria-label="Game summary and moves">
              <section
                data-testid="review-summary"
                className="rounded-2xl border border-white/10 bg-white/[0.03] p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-[11px] font-black uppercase tracking-[0.2em] text-white/60">
                    Performance
                  </h2>
                  {analysisState.status === "analyzing" && (
                    <span
                      data-testid="review-analysis-progress"
                      aria-live="polite"
                      className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-cyan-200/70"
                    >
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300"
                      />
                      Analyzing
                    </span>
                  )}
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-2">
                  <Stat label="Total moves" value={totalMoves} testId="review-total-moves" />
                  <Stat
                    label="Completion time"
                    value={formatDuration(data.durationMs)}
                    testId="review-duration"
                  />
                  <Stat
                    label="Great"
                    value={counts ? counts.great : "—"}
                    tone="text-emerald-300"
                    testId="review-great"
                  />
                  <Stat
                    label="Brilliant"
                    value={counts ? counts.brilliant : "—"}
                    tone="text-cyan-300"
                    testId="review-brilliant"
                  />
                  <Stat
                    label="Mistakes"
                    value={counts ? counts.mistake : "—"}
                    tone="text-orange-300"
                    testId="review-mistakes"
                  />
                  <Stat
                    label="Blunders"
                    value={counts ? counts.blunder : "—"}
                    tone="text-rose-300"
                    testId="review-blunders"
                  />
                </dl>

                <div
                  data-testid="review-accuracy"
                  className="mt-3 rounded-xl border border-cyan-300/25 bg-cyan-300/[0.06] p-4"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-cyan-200/80">
                      Accuracy
                    </h3>
                    <span className="text-[9px] uppercase tracking-wider text-white/35">engine</span>
                  </div>
                  <p className="mt-1 font-mono text-3xl font-black tabular-nums text-cyan-200">
                    {accuracy == null ? "—" : `${accuracy.toFixed(1)}%`}
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-white/45">{accuracyNote}</p>
                </div>

                {analysisState.status === "error" && (
                  <p
                    data-testid="review-analysis-error"
                    className="mt-3 text-[11px] leading-relaxed text-amber-200/70"
                  >
                    Analysis could not be completed. The board and move log still work.
                  </p>
                )}
              </section>

              <section
                data-testid="review-moments"
                className="rounded-2xl border border-white/10 bg-white/[0.03] p-4"
              >
                <h2 className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.2em] text-white/60">
                  <IconSparkles size={13} className="text-cyan-300" aria-hidden="true" />
                  Key moments
                </h2>
                {moments.length === 0 ? (
                  <p className="mt-2 text-[11px] leading-relaxed text-white/35">
                    {analysisState.status === "analyzing"
                      ? "Finding the moments that shaped this game…"
                      : "No standout moments were found."}
                  </p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {moments.map((moment) => {
                      const meta = RATING_META[moment.rating];
                      const move = moves[moment.ply];
                      return (
                        <li key={`${moment.ply}-${moment.rating}`}>
                          <button
                            type="button"
                            onClick={() => setSelectedPly(moment.ply + 1)}
                            className="flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left transition-colors hover:border-white/10 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 motion-reduce:transition-none"
                          >
                            <span className="w-6 shrink-0 text-right font-mono text-[10px] text-white/35">
                              {moment.ply + 1}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs text-white/80">
                                {describeMove(move?.move)}
                              </span>
                              <span className="block truncate text-[10px] text-white/35">
                                {moment.tags.slice(0, 2).map(tagLabel).join(" · ") || "Notable move"}
                              </span>
                            </span>
                            <span
                              className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider ${meta.chip}`}
                            >
                              {meta.label}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section
                data-testid="review-timeline"
                className="rounded-2xl border border-white/10 bg-white/[0.03] p-4"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h2 className="text-[11px] font-black uppercase tracking-[0.2em] text-white/60">
                    Move timeline
                  </h2>
                  <span className="font-mono text-[10px] text-white/35">
                    {selectedPly}/{totalMoves}
                  </span>
                </div>
                {totalMoves === 0 ? (
                  <p className="mt-2 text-[11px] text-white/35">No moves were recorded.</p>
                ) : (
                  <ol
                    aria-label="Move timeline"
                    className="mt-2 max-h-[18rem] space-y-0.5 overflow-y-auto overscroll-contain pr-1 sm:max-h-[22rem] lg:max-h-[26rem]"
                  >
                    {moves.map((move, index) => {
                      const rating = ratingForMove(analysis, index);
                      const meta = rating ? RATING_META[rating] : null;
                      const isSelected = selectedPly === index + 1;
                      return (
                        <li key={index}>
                          <button
                            type="button"
                            ref={isSelected ? selectedRef : null}
                            onClick={() => setSelectedPly(index + 1)}
                            aria-current={isSelected ? "step" : undefined}
                            aria-label={`Move ${index + 1}: ${describeMove(move.move)}${
                              meta ? `, rated ${meta.label}` : ", not rated yet"
                            }`}
                            data-testid={`review-move-${index}`}
                            data-rating={rating ?? "unrated"}
                            className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 motion-reduce:transition-none ${
                              isSelected
                                ? "border-cyan-300/40 bg-cyan-300/10"
                                : "border-transparent hover:border-white/10 hover:bg-white/5"
                            }`}
                          >
                            <span className="w-7 shrink-0 text-right font-mono text-[10px] tabular-nums text-white/35">
                              {index + 1}
                            </span>
                            <span
                              className={`min-w-0 flex-1 truncate text-xs ${
                                isSelected ? "text-white" : "text-white/65"
                              }`}
                            >
                              {describeMove(move.move)}
                            </span>
                            {meta ? (
                              <span
                                className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider ${meta.chip}`}
                              >
                                <span
                                  className={`h-1 w-1 rounded-full ${meta.dot}`}
                                  aria-hidden="true"
                                />
                                {meta.label}
                              </span>
                            ) : (
                              <span className="shrink-0 text-[9px] uppercase tracking-wider text-white/25">
                                —
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>
            </aside>
          </div>
        </>
      )}
    </Shell>
  );
}
