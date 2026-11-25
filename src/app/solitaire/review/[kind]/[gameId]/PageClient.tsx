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
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconSparkles,
} from "@tabler/icons-react";

import Footer from "../../../../../components/Footer";
import GlitchSay from "../../../../../components/mascot/GlitchSay";
import NavigationBar from "../../../../../components/navigation-bar";
import SolitaireBoard from "../../../../../components/solitaire-duel/SolitaireBoard";
import { useSolitaireReviewAnalysis } from "../../../../../hooks/useSolitaireReviewAnalysis";
import { useTranslation } from "../../../../../hooks/useTranslation";
import { buildGlitchReviewReactions } from "../../../../../lib/mascot/glitchReview";
import {
  buildLocalReview,
  isLocalReviewGameId,
  readLocalCompletedGames,
} from "../../../../../lib/solitaire-duel/localReview";
import {
  meaningfulInsightCount,
  personalBestComparison,
  reviewFoundationCount,
  reviewHighlights,
  reviewLearningForHighlights,
  type PersonalBestComparison,
} from "../../../../../lib/solitaire-duel/reviewSummary";
import { formatDuration } from "../../../../../lib/solitaire-duel/soloStats.js";
import type { MoveRecommendation } from "../../../../../lib/solitaire-duel/alternatives";
import {
  buildRecommendationDemo,
  recommendationForMove,
} from "../../../../../lib/solitaire-duel/reviewRecommendation";
import {
  reviewPlyFromSearch,
  reviewPracticePlan,
} from "../../../../../lib/solitaire-duel/reviewPractice";
import type {
  ReviewGameKind,
  ReviewStatus,
  SolitaireReview,
} from "../../../../../lib/solitaire-duel/review";
import {
  isInsightRating,
  ratingForMove,
  RATING_META,
  reconstructReviewPosition,
  reviewInsightForMove,
  STATUS_META,
  stepPly,
  summaryCounts,
  tagLabel,
  type ReviewNavigationAction,
} from "../../../../../lib/solitaire-duel/reviewView";

const NOOP = () => {};

/** Playback speeds. 1x is deliberately readable rather than a fast skim. */
const PLAYBACK_SPEEDS = [
  { label: "0.5x", value: 0.5, ms: 1400 },
  { label: "1x", value: 1, ms: 700 },
  { label: "2x", value: 2, ms: 350 },
] as const;
const DEFAULT_PLAYBACK_SPEED = 1;
const PLAYBACK_SPEED_STORAGE_KEY = "grynd:solitaire-review:playback-speed";

function Shell({
  children,
  backHref,
  backLabel,
  navPath,
}: {
  children: ReactNode;
  backHref: string;
  backLabel: string;
  navPath: string;
}) {
  return (
    <div className="relative min-h-screen bg-[color:var(--bg-page)] pb-24 text-[color:var(--text-primary)] md:pb-0">
      <NavigationBar currentPath={navPath} />
      <main className="mx-auto max-w-7xl px-4 pt-24 sm:px-6 md:pt-28">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1.5 rounded-md text-xs font-semibold text-white/50 transition-colors hover:text-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 motion-reduce:transition-none"
        >
          <IconArrowLeft size={14} aria-hidden="true" />
          {backLabel}
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
      <dt className="text-[10px] font-bold uppercase tracking-wider text-[color:var(--text-muted)]">{label}</dt>
      <dd className={`mt-0.5 font-mono text-xl font-black tabular-nums ${tone}`}>{value}</dd>
    </div>
  );
}

type ReviewTranslate = (key: string, params?: Record<string, unknown>) => string;
const RANK_LABELS: Record<number, string> = {
  1: "A",
  11: "J",
  12: "Q",
  13: "K",
};
const SUIT_GLYPHS: Record<string, string> = {
  spades: "\u2660",
  hearts: "\u2665",
  diamonds: "\u2666",
  clubs: "\u2663",
};
type MoveShape = {
  kind?: string;
  card?: { rank?: number; suit?: string } | null;
  fromColumn?: number;
  toColumn?: number;
  suit?: string;
};

function localizedCard(card: MoveShape["card"]): string {
  if (!card) return "";
  const rank = RANK_LABELS[Number(card.rank)] ?? String(card.rank ?? "");
  return `${rank}${SUIT_GLYPHS[String(card.suit)] ?? ""}`;
}

function localizedColumn(t: ReviewTranslate, column: number | undefined): string {
  return Number.isFinite(Number(column))
    ? t("solitaireReview.moves.column", { column: Number(column) + 1 })
    : "";
}

function localizedMove(t: ReviewTranslate, move: unknown): string {
  const value = (move ?? {}) as MoveShape;
  const foundation = t("solitaireReview.moves.foundation", {
    suit: SUIT_GLYPHS[String(value.suit)] ?? "",
  });
  switch (value.kind) {
    case "draw":
      return t("solitaireReview.moves.draw");
    case "waste-to-foundation":
      return t("solitaireReview.moves.wasteToFoundation", { suit: foundation });
    case "waste-to-tableau":
      return t("solitaireReview.moves.wasteToTableau", {
        column: localizedColumn(t, value.toColumn),
      });
    case "tableau-to-foundation":
      return t("solitaireReview.moves.tableauToFoundation", {
        card: localizedCard(value.card),
        suit: foundation,
      });
    case "tableau-to-tableau":
      return t("solitaireReview.moves.tableauToTableau", {
        card: localizedCard(value.card),
        from: localizedColumn(t, value.fromColumn),
        to: localizedColumn(t, value.toColumn),
      });
    case "foundation-to-tableau":
      return t("solitaireReview.moves.foundationToTableau", {
        card: localizedCard(value.card),
        column: localizedColumn(t, value.toColumn),
      });
    default:
      return t("solitaireReview.moves.unknown");
  }
}

function StatusChip({ status, label }: { status: ReviewStatus; label?: string }) {
  const meta = STATUS_META[status];
  return (
    <span
      data-testid="review-status"
      className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wider ${meta.chip}`}
    >
      {label ?? meta.label}
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
  const [playing, setPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(DEFAULT_PLAYBACK_SPEED);
  // Same-mode history for the closing summary. Null means no reliable source
  // (duel, guest history unavailable, failed request) and nothing is shown.
  const [personalBest, setPersonalBest] = useState<{
    comparison: PersonalBestComparison | null;
    completedGames: number;
  } | null>(null);
  // True only for the commit produced by a single forward step. Timeline
  // jumps, Home/End, rewinds and the initial paint always take the fast path.
  const [animateStep, setAnimateStep] = useState(false);
  // Phase 2: the read-only better-move demonstration. `null` means the board
  // shows the real review position. Nothing here can reach the log or result.
  const [demo, setDemo] = useState<{
    recommendation: MoveRecommendation;
    phase: "before" | "after";
  } | null>(null);

  // Restore the pace this browser last picked. Reading in an effect rather than
  // in the state initializer keeps the server markup and the first client
  // render in agreement, so there is no hydration mismatch.
  useEffect(() => {
    try {
      const stored = Number(window.localStorage.getItem(PLAYBACK_SPEED_STORAGE_KEY));
      if (PLAYBACK_SPEEDS.some((option) => option.value === stored)) {
        setPlaybackSpeed(stored);
      }
    } catch {
      // Storage can be unavailable (private mode, blocked cookies): 1x.
    }
  }, []);
  const { t } = useTranslation();
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const selectedRefKey = useRef<string | null>(null);
  const timelineListRef = useRef<HTMLOListElement | null>(null);

  const backHref =
    kind === "daily" ? "/daily" : kind === "duel" ? `/casino/solitaire-duel/${gameId}` : "/solitaire";
  // The Duel page reopens the settled match (its result screen); the two
  // single-player modes reopen the mode surface that owns the history list.
  const backLabel = t(
    kind === "duel"
      ? "solitaireReview.ui.backDuel"
      : kind === "daily"
        ? "solitaireReview.ui.backDaily"
        : "solitaireReview.ui.backSolo",
  );
  const navPath = kind === "daily" ? "/daily" : "/solitaire";

  // ── The one read: the server's validated review payload ─────────────────
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    setSelectedPly(0);
    setPlaying(false);
    setAnimateStep(false);

    // A guest's completed solo game lives in this browser (localReview.ts).
    // Its local-only id is never sent to the server; the review is rebuilt
    // from the stored seed + final log instead.
    if (kind !== "duel" && isLocalReviewGameId(gameId)) {
      const review = buildLocalReview(gameId);
      if (review) {
        setData(review);
        setSelectedPly(
          reviewPlyFromSearch(window.location.search, review.moves.length),
        );
      } else
        setError(t("solitaireReview.ui.errorLocal"));
      setLoading(false);
      return () => {
        alive = false;
      };
    }

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
          if (response.status === 401)
            throw new Error(t("solitaireReview.ui.errorSignedIn"));
          if (response.status === 404)
            throw new Error(t("solitaireReview.ui.errorNotFound"));
          if (response.status === 409)
            throw new Error(body?.error || t("solitaireReview.ui.errorNotReady"));
          throw new Error(body?.error || t("solitaireReview.ui.errorUnable"));
        }
        if (!body?.data?.deal || !Array.isArray(body.data.moves)) {
          throw new Error(t("solitaireReview.ui.errorIncomplete"));
        }
        return body.data as SolitaireReview;
      })
      .then((payload) => {
        if (!alive) return;
        setData(payload);
        // Returning from Practice restores the exact reviewed move; a fresh
        // visit without `ply` still starts at the opening position.
        setSelectedPly(
          reviewPlyFromSearch(window.location.search, payload.moves.length),
        );
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        if (cause instanceof Error && cause.name === "AbortError") return;
        setError(
          cause instanceof Error
            ? cause.message
            : t("solitaireReview.ui.errorUnable"),
        );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [gameId, kind, t]);

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

  // ── Phase 2: better-move recommendation + demonstration ─────────────────
  // Read from the selected move's own analysis entry; null for routine,
  // positive and uncertain moves, so the panel and its button simply vanish.
  const recommendation = recommendationForMove(analysis, selectedPly - 1);
  // Phase 3: the optional drill for this recommendation. The plan carries ids
  // and links only — no deal, no seed, no hidden card.
  const practicePlan = useMemo(
    () =>
      data
        ? reviewPracticePlan({
            analysis,
            moveIndex: selectedPly - 1,
            kind,
            gameId,
            ply: selectedPly,
          })
        : null,
    [analysis, data, gameId, kind, selectedPly],
  );
  const demoBuild = useMemo(
    () =>
      demo && data
        ? buildRecommendationDemo(data.deal, data.moves, demo.recommendation)
        : null,
    [demo, data],
  );
  const demoTimerRef = useRef<number | null>(null);
  const clearDemoTimer = useCallback(() => {
    if (demoTimerRef.current !== null) {
      window.clearTimeout(demoTimerRef.current);
      demoTimerRef.current = null;
    }
  }, []);
  // Closing is presentation-only: the selected ply, the log and the analysis
  // are untouched, so the board returns to the real played position.
  const closeRecommendation = useCallback(() => {
    clearDemoTimer();
    setDemo(null);
  }, [clearDemoTimer]);
  const openRecommendation = useCallback(() => {
    if (!recommendation) return;
    // Advice always stops autoplay, and a second rapid click must not schedule
    // a second before→after transition.
    setPlaying(false);
    setAnimateStep(false);
    clearDemoTimer();
    setDemo({ recommendation, phase: "before" });
    // Paint the exact pre-move position first, then let the shared board's own
    // review animation show only the recommended move being applied.
    demoTimerRef.current = window.setTimeout(() => {
      demoTimerRef.current = null;
      setDemo((current) => (current ? { ...current, phase: "after" } : null));
    }, 220);
  }, [clearDemoTimer, recommendation]);
  useEffect(() => () => clearDemoTimer(), [clearDemoTimer]);

  const boardView = demo
    ? demoBuild?.ok
      ? demo.phase === "after"
        ? demoBuild.after.view
        : demoBuild.before.view
      : null
    : view;
  const boardPly = demo
    ? demoBuild?.ok
      ? demo.phase === "after"
        ? demoBuild.after.ply
        : demoBuild.before.ply
      : 0
    : position?.ok
      ? position.state.ply
      : 0;
  const boardAnimate = demo ? demo.phase === "after" : animateStep;
  const boardReady = demo ? Boolean(demoBuild?.ok) : Boolean(position?.ok);

  // One move per step. Key moments remain a separate set of jump targets in
  // the timeline, but the arrows and autoplay walk the validated log exactly.
  const go = useCallback(
    (action: ReviewNavigationAction, animate = false) => {
      setAnimateStep(animate);
      setSelectedPly((current) => stepPly(current, totalMoves, action));
    },
    [totalMoves],
  );

  // Any manual step — an arrow button, a timeline row, a key moment or the
  // keyboard — stops a running playback. Only the timer advances without
  // pausing, so playback never fights the player for control.
  const goManually = useCallback(
    (action: ReviewNavigationAction) => {
      // Any real navigation leaves the demonstration first, so the board can
      // never show a recommended position after the player has moved on.
      closeRecommendation();
      setPlaying(false);
      go(action, action === "next");
    },
    [closeRecommendation, go],
  );
  const selectManually = useCallback(
    (ply: number) => {
      closeRecommendation();
      setPlaying(false);
      setAnimateStep(false);
      setSelectedPly(ply);
    },
    [closeRecommendation],
  );
  const restartReview = useCallback(() => {
    closeRecommendation();
    setPlaying(false);
    setAnimateStep(false);
    setSelectedPly(0);
  }, [closeRecommendation]);

  // Shared by the Play button and the Space shortcut, so both paths restart
  // from the deal when pressed at the final position.
  const togglePlay = useCallback(() => {
    closeRecommendation();
    if (playing) {
      setPlaying(false);
      return;
    }
    if (totalMoves === 0) return;
    setAnimateStep(false);
    if (selectedPly >= totalMoves) setSelectedPly(0);
    setPlaying(true);
  }, [closeRecommendation, playing, selectedPly, totalMoves]);

  // The next position the arrow/Play will land on, named in the shortcut hint.
  const nextTarget = selectedPly >= totalMoves ? null : selectedPly + 1;
  const playbackMs =
    PLAYBACK_SPEEDS.find((option) => option.value === playbackSpeed)?.ms ?? 700;

  // Arrow keys work wherever focus is on the page — a player who has just
  // scrolled the board into view should not have to click a control first.
  // Keys typed into a field are never stolen, and preventDefault also stops the
  // arrows from scrolling the page underneath the board.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape" && demo) {
        event.preventDefault();
        closeRecommendation();
        return;
      }
      // Space is Play/Pause, except on a focused control: a button would also
      // activate natively (toggling twice) and Space opens a select.
      if (event.key === " " && !target?.closest("button, a, select, summary")) {
        event.preventDefault();
        if (!event.repeat) togglePlay();
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goManually("previous");
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        goManually("next");
      } else if (event.key === "Home") {
        event.preventDefault();
        goManually("start");
      } else if (event.key === "End") {
        event.preventDefault();
        goManually("end");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeRecommendation, demo, goManually, togglePlay]);

  // Playback walks the validated log one accepted move at a time. The timeout
  // is re-armed after each step, so changing the speed or the selected position
  // simply schedules the next move from where the player is now. It pauses
  // itself at the final position, and the cleanup stops the timer when the page
  // unmounts or Play is toggled off.
  useEffect(() => {
    if (!playing) return;
    if (selectedPly >= totalMoves) {
      setPlaying(false);
      return;
    }
    // 2x steps every 350ms; a 300–340ms card flip would overlap the next step,
    // so fast playback shows the authoritative position immediately instead of
    // flickering. Manual steps still animate at any selected speed.
    const timer = window.setTimeout(() => go("next", playbackSpeed < 2), playbackMs);
    return () => window.clearTimeout(timer);
  }, [playing, selectedPly, totalMoves, go, playbackMs, playbackSpeed]);

  // Keep the selected timeline row visible WITHOUT moving the whole page.
  // `scrollIntoView` walks every scrollable ancestor, including the window,
  // which is why skimming used to drag the page down. Only the timeline's own
  // scrollTop is adjusted, and only when the row is actually out of view.
  useEffect(() => {
    if (selectedRefKey.current === `${selectedPly}`) return;
    selectedRefKey.current = `${selectedPly}`;
    const list = timelineListRef.current;
    const row = selectedRef.current;
    if (!list || !row) return;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    if (rowRect.top < listRect.top) {
      list.scrollTop -= listRect.top - rowRect.top;
    } else if (rowRect.bottom > listRect.bottom) {
      list.scrollTop += rowRect.bottom - listRect.bottom;
    }
  }, [selectedPly]);

  const currentMove = selectedPly > 0 ? moves[selectedPly - 1] : null;
  const currentRating = ratingForMove(analysis, selectedPly - 1);
  const currentMeta = isInsightRating(currentRating) ? RATING_META[currentRating] : null;
  const insight = currentMove
    ? reviewInsightForMove(analysis, selectedPly - 1, currentMove.move)
    : null;
  const glitchReaction =
    selectedPly > 0 ? glitchReactions.get(selectedPly - 1) ?? null : null;

  const counts = summaryCounts(analysis);
  const moments = useMemo(
    () => reviewHighlights(analysis, totalMoves, 4),
    [analysis, totalMoves],
  );
  const foundations = useMemo(
    () => (data ? reviewFoundationCount(data.deal, data.moves) : null),
    [data],
  );
  const insights = useMemo(() => meaningfulInsightCount(analysis), [analysis]);
  const learning = useMemo(
    () => reviewLearningForHighlights(moments),
    [moments],
  );
  const status = data?.status ?? "incomplete";
  const rejectedAt =
    position && "rejectedAt" in position ? position.rejectedAt : null;
  const partialNote = analysis?.partial
    ? t("solitaireReview.insight.partial", {
        count: analysis.summary.movesAnalyzed,
        total: totalMoves,
      })
    : null;

  // The free plan gets a fixed number of fresh analyses per day; the API says
  // so (`analysisLimited`) and withholds only the scored analysis — the deal
  // and the move log above are still fully reviewable.
  const analysisLimited = Boolean(
    (data as { analysisLimited?: boolean } | null)?.analysisLimited,
  );
  const analysisPending = analysisState.status === "analyzing";
  const localizedTag = (tag: string) => {
    const key = `solitaireReview.tags.${tag}`;
    const value = t(key);
    return value === key ? tagLabel(tag) : value;
  };
  const localizedRating = (rating: string) => {
    const key = `solitaireReview.ratings.${rating}`;
    const value = t(key);
    return value === key
      ? RATING_META[rating as keyof typeof RATING_META]?.label ?? rating
      : value;
  };
  const localizedText = (key: string) => {
    const value = t(key);
    return value === key ? null : value;
  };
  const insightFacts = insight
    ? insight.tags
        .map((tag) => localizedText(`solitaireReview.insight.facts.${tag}`))
        .filter((text): text is string => Boolean(text))
    : [];
  if (insight && insightFacts.length === 0) {
    insightFacts.push(
      insight.rating === "great" || insight.rating === "good"
        ? t("solitaireReview.insight.whyPositive")
        : t("solitaireReview.insight.whyNegative"),
    );
  }
  const insightWhy = insight
    ? insight.tags.includes("revealed-hidden") || insight.tags.includes("opened-column")
      ? t("solitaireReview.insight.whyReveal")
      : insight.tags.includes("unlocked-sequence") ||
          insight.tags.includes("king-to-empty-column")
        ? t("solitaireReview.insight.whySpace")
        : insight.tags.includes("pulled-from-foundation")
          ? t("solitaireReview.insight.whyFoundation")
          : insight.tags.includes("pointless-shuffle") ||
              insight.tags.includes("wasted-redeal")
            ? t("solitaireReview.insight.whyShuffle")
            : insight.tags.includes("foundation-progress")
              ? t("solitaireReview.insight.whyFoundationProgress")
              : insight.rating === "great" || insight.rating === "good"
                ? t("solitaireReview.insight.whyPositive")
                : t("solitaireReview.insight.whyNegative")
    : null;
  const insightAlternative = insight?.bestAlternative
    ? t(
        insight.bestAlternative.relation === "higher-ranked"
          ? "solitaireReview.insight.altHigher"
          : insight.bestAlternative.relation === "equal-ranked"
            ? "solitaireReview.insight.altEqual"
            : "solitaireReview.insight.altLower",
        { move: localizedMove(t, insight.bestAlternative.move) },
      )
    : null;
  const insightLesson = insight
    ? insight.tags.includes("revealed-hidden")
      ? t("solitaireReview.insight.lessonReveal")
      : insight.tags.includes("opened-column") ||
          insight.tags.includes("unlocked-sequence") ||
          insight.tags.includes("king-to-empty-column")
        ? t("solitaireReview.insight.lessonSpace")
        : insight.tags.includes("pulled-from-foundation") ||
            insight.tags.includes("foundation-progress")
          ? t("solitaireReview.insight.lessonFoundation")
          : insight.tags.includes("pointless-shuffle") ||
              insight.tags.includes("wasted-redeal")
            ? t("solitaireReview.insight.lessonShuffle")
            : null
    : null;

  // Every line is generated from the recommendation's measured gains, not from
  // a generic template about the move kind. Counts stay specific and singular /
  // plural is chosen from the actual evidence.
  const recommendationReasons = recommendation
    ? (() => {
        const gains = recommendation.evidence;
        const specific = recommendation.why.filter(
          (reason) => reason !== "higher-visible-score",
        );
        const codes = specific.length > 0 ? specific : ["higher-visible-score"];
        return codes.map((reason) => {
          switch (reason) {
            case "advances-foundation":
              return t(
                gains.foundationGain === 1
                  ? "solitaireReview.recommendation.reasons.foundationOne"
                  : "solitaireReview.recommendation.reasons.foundationMany",
                { count: gains.foundationGain },
              );
            case "reveals-a-card":
              return t(
                gains.revealsGain === 1
                  ? "solitaireReview.recommendation.reasons.revealOne"
                  : "solitaireReview.recommendation.reasons.revealMany",
                { count: gains.revealsGain },
              );
            case "frees-a-column":
              return t(
                gains.emptyColumnsGain === 1
                  ? "solitaireReview.recommendation.reasons.emptyOne"
                  : "solitaireReview.recommendation.reasons.emptyMany",
                { count: gains.emptyColumnsGain },
              );
            case "productive-instead-of-draw":
              return t("solitaireReview.recommendation.reasons.productiveInsteadOfDraw");
            default:
              return t("solitaireReview.recommendation.reasons.higherScore");
          }
        });
      })()
    : [];

  useEffect(() => {
    setPersonalBest(null);
    if (
      !data ||
      data.status !== "complete" ||
      data.durationMs == null ||
      data.gameKind === "duel"
    ) {
      return undefined;
    }

    let alive = true;
    const durationMs = data.durationMs;
    const mode = data.gameKind;
    const applySummary = (summary: {
      bestMs?: unknown;
      completed?: unknown;
    } | null) => {
      if (!alive || !summary) return;
      const completedGames = Math.max(0, Math.floor(Number(summary.completed) || 0));
      setPersonalBest({
        completedGames,
        comparison: personalBestComparison({
          durationMs,
          bestMs: Number(summary.bestMs),
          completedGames,
        }),
      });
    };

    // A local game's history is the same-device ring. Its records are all
    // completed wins, so the comparison is same-mode and does not mix modes.
    if (isLocalReviewGameId(gameId)) {
      const rows = readLocalCompletedGames().filter((row) => row.mode === mode);
      const times = rows
        .map((row) => Number(row.elapsedMs))
        .filter((ms) => Number.isFinite(ms) && ms > 0);
      applySummary({
        bestMs: times.length > 0 ? Math.min(...times) : null,
        completed: rows.length,
      });
      return () => {
        alive = false;
      };
    }

    const controller = new AbortController();
    const url = mode === "solo" ? "/api/solitaire/solo" : "/api/solitaire/daily";
    fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return null;
        const body = (await response.json().catch(() => null)) as
          | { success?: boolean; data?: { summary?: { bestMs?: unknown; completed?: unknown } } }
          | null;
        return body?.success ? body.data?.summary ?? null : null;
      })
      .then((summary) => applySummary(summary))
      .catch(() => {
        // A failed history request hides the comparison; the review itself is
        // unaffected.
      });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [data, gameId]);

  return (
    <Shell backHref={backHref} backLabel={backLabel} navPath={navPath}>
      {/* Daily allowance spent: the deal and the move log above are still fully
          reviewable, only the scored analysis is withheld. This is the upgrade
          entry point on the review surface itself. */}
      {analysisLimited && (
        <div
          data-testid="review-analysis-limit"
          role="status"
          className="mt-5 max-w-3xl rounded-[var(--radius-surface)] border border-[color:var(--border-warning)] bg-[color:var(--bg-surface)] p-4"
        >
          <p className="text-[11px] font-black uppercase tracking-[0.24em] text-[color:var(--state-gold)]">
            {t("solitaireReview.ui.proKicker")}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-white/75">
            {t("solitaireReview.ui.proBody")}
          </p>
          <Link
            href="/upgrade-pro"
            className="mt-3 inline-flex rounded-lg border border-[color:var(--border-warning)] bg-[color:var(--bg-panel)] px-4 py-2 text-sm font-semibold text-[color:var(--state-gold)] transition-colors hover:bg-[color:var(--bg-surface)] motion-reduce:transition-none"
          >
            {t("solitaireReview.ui.proCta")}
          </Link>
        </div>
      )}
      <header className="mt-5 max-w-3xl">
        <p className="text-[11px] font-black uppercase tracking-[0.4em] text-cyan-300/80">
          {t("solitaireReview.ui.headerKicker")}
        </p>
        <h1 className="mt-3 text-4xl font-black leading-[0.95] tracking-tight sm:text-5xl">
          {t("solitaireReview.ui.titleLead")}{" "}
          <span className="text-cyan-300">{t("solitaireReview.ui.titleAccent")}</span>
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-white/55 sm:text-base">
          {t("solitaireReview.ui.headerDescription")}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-white/55">
          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 font-bold uppercase tracking-wider">
            {t(`solitaireReview.modes.${kind}`)}
          </span>
          {data && (
            <>
              <StatusChip
                status={status}
                label={t(`solitaireReview.status.${status}`)}
              />
              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                {data.variant} · v{data.variantVersion}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                <IconCards size={12} aria-hidden="true" />{" "}
                {t("solitaireReview.ui.movesCount", { count: totalMoves })}
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
          {t("solitaireReview.ui.loading")}
        </p>
      )}

      {!loading && error && (
        <div
          data-testid="review-error"
          role="alert"
          className="mt-8 rounded-2xl border border-rose-400/30 bg-rose-400/10 p-6 text-sm text-rose-100"
        >
          <p className="flex items-center gap-2 font-semibold">
            <IconAlertTriangle size={16} aria-hidden="true" />{" "}
            {t("solitaireReview.ui.unavailable")}
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
                  ? t("solitaireReview.ui.incompleteForfeit")
                  : t("solitaireReview.ui.incompleteNotCompleted")}
              </p>
            </div>
          )}

          <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
            {/* ── Board + navigation ─────────────────────────────────────── */}
            <section
              aria-label={t("solitaireReview.ui.boardReviewAria")}
              className="min-w-0 rounded-[var(--radius-surface)] border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] p-3 shadow-[var(--shadow-raise)] sm:p-5"
            >
              {/* Inline commentary leads the analysis: GLITCH's line for the
                  selected move sits above the board it describes. Keyed by the
                  stable event id so revisiting a move shows that same line. */}
              {glitchReaction && (
                <div
                  data-testid="review-glitch"
                  data-glitch-move={glitchReaction.moveNumber}
                  className="mb-3"
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

              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-white/40">
                    {selectedPly === 0
                      ? t("solitaireReview.ui.initialDeal")
                      : t("solitaireReview.ui.moveOf", {
                          move: selectedPly,
                          total: totalMoves,
                        })}
                  </p>
                  <p
                    data-testid="review-current-move"
                    className="mt-0.5 truncate text-sm font-semibold text-white"
                  >
                    {selectedPly === 0
                      ? t("solitaireReview.ui.startPosition")
                      : localizedMove(t, currentMove?.move)}
                  </p>
                </div>
                {currentMeta ? (
                  <span
                    data-testid="review-current-rating"
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wider ${currentMeta.chip}`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${currentMeta.dot}`} aria-hidden="true" />
                    {localizedRating(currentRating ?? "normal")}
                  </span>
                ) : selectedPly > 0 ? (
                  <span className="text-[10px] font-bold uppercase tracking-wider text-white/35">
                    {t("solitaireReview.ui.noExtraInsight")}
                  </span>
                ) : null}
              </div>

              {demo && (
                <div
                  data-testid="review-demo"
                  data-phase={demo.phase}
                  role="status"
                  aria-live="polite"
                  className="mb-3 rounded-xl border border-amber-300/30 bg-amber-300/[0.07] p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[10px] font-black uppercase tracking-[0.18em] text-amber-200/85">
                      {t("solitaireReview.recommendation.demoTitle", {
                        move: demo.recommendation.ply + 1,
                      })}
                    </p>
                    <span className="inline-flex shrink-0 items-center rounded-full border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-amber-100/85">
                      {t("solitaireReview.recommendation.demoBadge")}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-white/65">
                    {t("solitaireReview.recommendation.demoNote")}
                  </p>
                  <button
                    type="button"
                    data-testid="review-demo-back"
                    onClick={closeRecommendation}
                    className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-lg border border-amber-300/35 bg-amber-300/10 px-3 text-[10px] font-black uppercase tracking-wider text-amber-100 transition-colors hover:bg-amber-300/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/70 motion-reduce:transition-none"
                  >
                    <IconArrowLeft size={14} aria-hidden="true" />
                    {t("solitaireReview.recommendation.demoBack")}
                  </button>
                </div>
              )}

              {boardReady ? (
                <div
                  data-testid="review-board"
                  data-ply={boardPly}
                  data-completed={boardView?.completed ? "true" : "false"}
                  data-review-animate={boardAnimate ? "true" : "false"}
                  data-demo={demo ? demo.phase : "false"}
                  className={`pointer-events-none select-none rounded-xl motion-reduce:transition-none ${
                    demo ? "ring-2 ring-amber-300/25" : ""
                  }`}
                >
                  <SolitaireBoard
                    view={boardView}
                    interactive={false}
                    readOnly
                    reviewAnimate={boardAnimate}
                    onMove={NOOP}
                  />
                </div>
              ) : (
                <div
                  data-testid="review-replay-error"
                  role="alert"
                  className="rounded-xl border border-rose-400/30 bg-rose-400/10 p-6 text-sm text-rose-100"
                >
                  {t("solitaireReview.ui.replayError")}
                  {rejectedAt != null
                    ? t("solitaireReview.ui.replayRejected", {
                        move: rejectedAt + 1,
                      })
                    : ""}
                  .
                </div>
              )}

              {insight && (
                <section
                  data-testid="review-insight"
                  aria-label={t("solitaireReview.insight.title")}
                  className="mt-3 rounded-xl border border-cyan-300/20 bg-cyan-300/[0.04] p-3 sm:p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[10px] font-black uppercase tracking-[0.18em] text-cyan-200/75">
                      {t("solitaireReview.insight.title")}
                    </p>
                    <span
                      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${RATING_META[insight.rating].chip}`}
                    >
                      {localizedRating(insight.rating)}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-white/75">
                    <span className="font-semibold text-white/90">
                      {t("solitaireReview.insight.played")}
                    </span>{" "}
                    {localizedMove(t, currentMove?.move)}
                  </p>
                  {recommendation && (
                    <div
                      data-testid="review-recommendation"
                      data-rating={recommendation.rating}
                      data-confidence={recommendation.confidence}
                      className="mt-3 rounded-lg border border-amber-300/25 bg-amber-300/[0.06] p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-[10px] font-black uppercase tracking-[0.18em] text-amber-200/85">
                          {t("solitaireReview.recommendation.title")}
                        </p>
                        <span
                          data-testid="review-recommendation-confidence"
                          className="inline-flex shrink-0 items-center rounded-full border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-amber-100/85"
                        >
                          {localizedRating(recommendation.rating)} ·{" "}
                          {t(
                            `solitaireReview.recommendation.confidence.${recommendation.confidence}`,
                          )}
                        </span>
                      </div>
                      <p className="mt-2 text-xs leading-relaxed text-white/80">
                        <span className="font-semibold text-white/90">
                          {t("solitaireReview.recommendation.instead")}
                        </span>{" "}
                        <span className="font-semibold text-amber-100">
                          {localizedMove(t, recommendation.move)}
                        </span>
                      </p>
                      <ul className="mt-1.5 space-y-0.5 text-[11px] leading-relaxed text-white/60">
                        {recommendationReasons.map((reason) => (
                          <li key={reason}>• {reason}</li>
                        ))}
                      </ul>
                      <p className="mt-1.5 text-[10px] leading-relaxed text-white/35">
                        {t("solitaireReview.recommendation.basis")}
                      </p>
                      {practicePlan && (
                        <>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <Link
                              href={practicePlan.practiceHref}
                              data-testid="review-practice-situation"
                              data-skill={practicePlan.skillId}
                              data-exercise={practicePlan.exerciseId}
                              data-lesson={practicePlan.lessonId ?? ""}
                              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[#00e5ff]/35 bg-[#00e5ff]/10 px-3 text-[10px] font-black uppercase tracking-wider text-[#9dd8ff] transition-colors hover:bg-[#00e5ff]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]/70 motion-reduce:transition-none"
                            >
                              {t("solitaireReview.recommendation.practiceCta")}
                              <span aria-hidden="true">→</span>
                            </Link>
                            {practicePlan.lessonId && (
                              <Link
                                href={`/learn/${practicePlan.lessonId}`}
                                data-testid="review-recommendation-lesson"
                                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-white/15 bg-white/[0.04] px-3 text-[10px] font-bold text-white/65 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 motion-reduce:transition-none"
                              >
                                {t("solitaireReview.recommendation.practiceLessonCta")}
                              </Link>
                            )}
                          </div>
                          <p className="mt-1.5 text-[10px] leading-relaxed text-white/35">
                            {t("solitaireReview.recommendation.practiceNote")}
                          </p>
                        </>
                      )}
                      <button
                        type="button"
                        data-testid="review-recommendation-toggle"
                        data-demo-active={demo ? "true" : "false"}
                        aria-pressed={Boolean(demo)}
                        onClick={demo ? closeRecommendation : openRecommendation}
                        className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-lg border border-amber-300/35 bg-amber-300/10 px-3 text-[10px] font-black uppercase tracking-wider text-amber-100 transition-colors hover:bg-amber-300/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/70 motion-reduce:transition-none"
                      >
                        <IconSparkles size={14} aria-hidden="true" />
                        {demo
                          ? t("solitaireReview.recommendation.hide")
                          : t("solitaireReview.recommendation.show")}
                      </button>
                    </div>
                  )}
                  <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-white/55">
                    {insightFacts.map((fact) => (
                      <li key={fact}>• {fact}</li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[11px] leading-relaxed text-white/55">
                    <span className="font-semibold text-white/75">
                      {t("solitaireReview.insight.whyLabel")}
                    </span>{" "}
                    {insightWhy}
                  </p>
                  {insightAlternative && !recommendation && (
                    <p className="mt-1.5 text-[11px] leading-relaxed text-white/55">
                      <span className="font-semibold text-white/75">
                        {t("solitaireReview.insight.alternativeLabel")}
                      </span>{" "}
                      {insightAlternative}
                    </p>
                  )}
                  {insightLesson && (
                    <p className="mt-1.5 text-[11px] leading-relaxed text-cyan-100/65">
                      <span className="font-semibold text-cyan-100/85">
                        {t("solitaireReview.insight.lessonLabel")}
                      </span>{" "}
                      {insightLesson}
                    </p>
                  )}
                  <p className="mt-2 text-[10px] leading-relaxed text-white/35">
                    {t("solitaireReview.insight.basis")}
                  </p>
                </section>
              )}

              <div className="mt-4 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div
                    className="flex items-center gap-1.5"
                    role="group"
                    aria-label={t("solitaireReview.ui.moveNavigation")}
                  >
                    <NavButton
                      label={t("solitaireReview.ui.navStart")}
                      testId="review-nav-first"
                      onClick={() => goManually("start")}
                      disabled={selectedPly === 0}
                    >
                      <IconChevronsLeft size={18} aria-hidden="true" />
                    </NavButton>
                    <NavButton
                      label={t("solitaireReview.ui.navPrev")}
                      testId="review-nav-prev"
                      onClick={() => goManually("previous")}
                      disabled={selectedPly === 0}
                    >
                      <IconChevronLeft size={18} aria-hidden="true" />
                    </NavButton>
                    <NavButton
                      label={t("solitaireReview.ui.navNext")}
                      testId="review-nav-next"
                      onClick={() => goManually("next")}
                      disabled={selectedPly >= totalMoves}
                    >
                      <IconChevronRight size={18} aria-hidden="true" />
                    </NavButton>
                    <NavButton
                      label={t("solitaireReview.ui.navEnd")}
                      testId="review-nav-last"
                      onClick={() => goManually("end")}
                      disabled={selectedPly >= totalMoves}
                    >
                      <IconChevronsRight size={18} aria-hidden="true" />
                    </NavButton>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
                    <button
                      type="button"
                      data-testid="review-autoplay"
                      onClick={togglePlay}
                      disabled={totalMoves === 0}
                      aria-pressed={playing}
                      title={
                        totalMoves === 0
                          ? t("solitaireReview.ui.noMovesToReplay")
                          : playing
                            ? t("solitaireReview.ui.pauseTitle")
                            : selectedPly >= totalMoves
                              ? t("solitaireReview.ui.replayTitle")
                              : t("solitaireReview.ui.playTitle")
                      }
                      className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-3 text-xs font-bold uppercase tracking-wider text-cyan-200 transition-colors hover:bg-cyan-300/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 disabled:cursor-not-allowed disabled:opacity-30 motion-reduce:transition-none"
                    >
                      {playing ? (
                        <IconPlayerPause size={16} aria-hidden="true" />
                      ) : (
                        <IconPlayerPlay size={16} aria-hidden="true" />
                      )}
                      {playing
                        ? t("solitaireReview.ui.pause")
                        : t("solitaireReview.ui.play")}
                    </button>
                    <button
                      type="button"
                      data-testid="review-restart"
                      onClick={restartReview}
                      aria-label={t("solitaireReview.ui.restartAria")}
                      title={t("solitaireReview.ui.restartAria")}
                      className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 text-[10px] font-bold uppercase tracking-wider text-white/55 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 motion-reduce:transition-none"
                    >
                      <IconRefresh size={15} aria-hidden="true" />
                      {t("solitaireReview.ui.restart")}
                    </button>
                    <label className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2 text-[10px] font-bold uppercase tracking-wider text-white/45 focus-within:ring-2 focus-within:ring-cyan-300/70">
                      <span className="hidden sm:inline">{t("solitaireReview.ui.speed")}</span>
                      <select
                        data-testid="review-playback-speed"
                        aria-label={t("solitaireReview.ui.playbackSpeed")}
                        value={playbackSpeed}
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          if (!PLAYBACK_SPEEDS.some((option) => option.value === next)) return;
                          setPlaybackSpeed(next);
                          // Remember the pace for the next review in this browser.
                          // Changing speed never moves the selected position.
                          try {
                            window.localStorage.setItem(
                              PLAYBACK_SPEED_STORAGE_KEY,
                              String(next),
                            );
                          } catch {
                            // A failed write must never break reviewing.
                          }
                        }}
                        className="rounded-md bg-transparent py-1 text-[11px] font-bold uppercase tracking-wider text-white/80 outline-none"
                      >
                        {PLAYBACK_SPEEDS.map((option) => (
                          <option
                            key={option.value}
                            value={option.value}
                            className="bg-[color:var(--bg-page)] text-[color:var(--text-primary)]"
                          >
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
                <p
                  data-testid="review-nav-hint"
                  className="text-[10px] uppercase tracking-wider text-white/30"
                >
                  {nextTarget != null
                    ? t("solitaireReview.ui.hintNext", { next: nextTarget })
                    : t("solitaireReview.ui.hintEnd")}
                </p>
              </div>

            </section>

            {/* ── Summary, moments, timeline ─────────────────────────────── */}
            <aside
              className="min-w-0 flex flex-col gap-4"
              aria-label={t("solitaireReview.ui.asideAria")}
            >
              <section
                data-testid="review-summary"
                className="rounded-2xl border border-white/10 bg-white/[0.03] p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-[11px] font-black uppercase tracking-[0.2em] text-white/60">
                    {t("solitaireReview.ui.moveInsights")}
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
                      {t("solitaireReview.ui.analyzing")}
                    </span>
                  )}
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-2">
                  <Stat
                    label={t("solitaireReview.ui.totalMoves")}
                    value={totalMoves}
                    testId="review-total-moves"
                  />
                  <Stat
                    label={t("solitaireReview.ui.completionTime")}
                    value={formatDuration(data.durationMs)}
                    testId="review-duration"
                  />
                  <Stat
                    label={t("solitaireReview.ui.greatMoves")}
                    value={counts ? counts.great : "—"}
                    tone="text-emerald-300"
                    testId="review-great"
                  />
                  <Stat
                    label={t("solitaireReview.ui.goodMoves")}
                    value={counts ? counts.good : "—"}
                    tone="text-emerald-200"
                    testId="review-good"
                  />
                  <Stat
                    label={t("solitaireReview.ui.inaccuracies")}
                    value={counts ? counts.inaccuracy : "—"}
                    tone="text-amber-300"
                    testId="review-inaccuracy"
                  />
                  <Stat
                    label={t("solitaireReview.ui.mistakes")}
                    value={counts ? counts.mistake : "—"}
                    tone="text-orange-300"
                    testId="review-mistake"
                  />
                </dl>

                <p className="mt-3 text-[11px] leading-relaxed text-white/40">
                  {t("solitaireReview.ui.labelsNote")}
                </p>
                {partialNote && (
                  <p
                    data-testid="review-partial-analysis"
                    className="mt-2 text-[11px] leading-relaxed text-amber-200/70"
                  >
                    {partialNote}
                  </p>
                )}

                {analysisState.status === "error" && (
                  <p
                    data-testid="review-analysis-error"
                    className="mt-3 text-[11px] leading-relaxed text-amber-200/70"
                  >
                    {t("solitaireReview.ui.analysisError")}
                  </p>
                )}
              </section>

              <section
                data-testid="review-moments"
                className="rounded-2xl border border-white/10 bg-white/[0.03] p-4"
              >
                <h2 className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-[0.2em] text-white/60">
                  <IconSparkles size={13} className="text-cyan-300" aria-hidden="true" />
                  {t("solitaireReview.highlights.title")}
                </h2>
                {moments.length === 0 ? (
                  <p className="mt-2 text-[11px] leading-relaxed text-white/35">
                    {analysisState.status === "analyzing"
                      ? t("solitaireReview.summary.analysisPending")
                      : t("solitaireReview.highlights.empty")}
                  </p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {moments.map((moment) => {
                      const meta = isInsightRating(moment.rating)
                        ? RATING_META[moment.rating]
                        : null;
                      const move = moves[moment.ply];
                      return (
                        <li key={`${moment.ply}-${moment.rating}`}>
                          <button
                            type="button"
                            data-testid={`review-highlight-${moment.ply}`}
                            data-ply={moment.ply + 1}
                            aria-label={t("solitaireReview.highlights.open", {
                              move: moment.ply + 1,
                            })}
                            onClick={() => selectManually(moment.ply + 1)}
                            className="flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left transition-colors hover:border-white/10 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 motion-reduce:transition-none"
                          >
                            <span className="w-6 shrink-0 text-right font-mono text-[10px] text-white/35">
                              {moment.ply + 1}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs text-white/80">
                                {localizedMove(t, move?.move)}
                              </span>
                              <span className="block truncate text-[10px] text-white/35">
                                {moment.tags.slice(0, 2).map(localizedTag).join(" · ") ||
                                  t("solitaireReview.highlights.noTag")}
                              </span>
                            </span>
                            {meta ? (
                              <span
                                className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider ${meta.chip}`}
                              >
                                {localizedRating(moment.rating)}
                              </span>
                            ) : (
                              <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white/35">
                                {localizedTag(moment.tags[0] ?? "")}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <section
                data-testid="review-timeline"
                className="order-first rounded-2xl border border-white/10 bg-white/[0.03] p-4"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h2 className="text-[11px] font-black uppercase tracking-[0.2em] text-white/60">
                    {t("solitaireReview.ui.moveTimeline")}
                  </h2>
                  <span className="font-mono text-[10px] text-white/35">
                    {selectedPly}/{totalMoves}
                  </span>
                </div>
                {totalMoves === 0 ? (
                  <p className="mt-2 text-[11px] text-white/35">
                    {t("solitaireReview.ui.noMovesRecorded")}
                  </p>
                ) : (
                  <ol
                    ref={timelineListRef}
                    aria-label={t("solitaireReview.ui.timelineAria")}
                    className="mt-2 max-h-[18rem] space-y-0.5 overflow-y-auto overscroll-contain pr-1 sm:max-h-[22rem] lg:max-h-[26rem]"
                  >
                    {moves.map((move, index) => {
                      const rating = ratingForMove(analysis, index);
                      const meta = isInsightRating(rating) ? RATING_META[rating] : null;
                      const isSelected = selectedPly === index + 1;
                      return (
                        <li key={index}>
                          <button
                            type="button"
                            ref={isSelected ? selectedRef : null}
                            onClick={() => selectManually(index + 1)}
                            aria-current={isSelected ? "step" : undefined}
                            aria-label={t("solitaireReview.ui.moveAria", {
                              move: index + 1,
                              description: `${localizedMove(t, move.move)}${
                                meta
                                  ? `, ${localizedRating(rating ?? "normal")}`
                                  : `, ${t("solitaireReview.ui.noExtraInsight")}`
                              }`,
                            })}
                            data-testid={`review-move-${index}`}
                            data-rating={meta ? rating : "unannotated"}
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
                              {localizedMove(t, move.move)}
                            </span>
                            {meta ? (
                              <span
                                className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider ${meta.chip}`}
                              >
                                <span
                                  className={`h-1 w-1 rounded-full ${meta.dot}`}
                                  aria-hidden="true"
                                />
                                {localizedRating(rating ?? "normal")}
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

          <section
            data-testid="review-completion-summary"
            aria-labelledby="review-completion-title"
            className="mt-6 rounded-[var(--radius-surface)] border border-[color:var(--border-hairline)] bg-[color:var(--bg-surface)] p-4 shadow-[var(--shadow-raise)] sm:p-5"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="max-w-2xl">
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-cyan-300/75">
                  {t("solitaireReview.summary.kicker")}
                </p>
                <h2
                  id="review-completion-title"
                  className="mt-1 text-xl font-black text-white sm:text-2xl"
                >
                  {t("solitaireReview.summary.title")}
                </h2>
                <p className="mt-1 text-xs leading-relaxed text-white/45">
                  {t("solitaireReview.summary.description")}
                </p>
              </div>
              <Link
                href={backHref}
                data-testid="review-close"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs font-bold text-white/75 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 motion-reduce:transition-none"
              >
                <IconArrowLeft size={14} aria-hidden="true" />
                {t("solitaireReview.summary.close")}
              </Link>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
              <Stat
                label={t("solitaireReview.summary.mode")}
                value={t(`solitaireReview.modes.${data.gameKind}`)}
                testId="review-summary-mode"
              />
              <Stat
                label={t("solitaireReview.summary.status")}
                value={t(`solitaireReview.status.${status}`)}
                testId="review-summary-status"
              />
              <Stat
                label={t("solitaireReview.summary.moves")}
                value={totalMoves}
                testId="review-summary-moves"
              />
              <Stat
                label={t("solitaireReview.summary.duration")}
                value={data.durationMs == null ? "—" : formatDuration(data.durationMs)}
                testId="review-summary-duration"
              />
              <Stat
                label={t("solitaireReview.summary.foundations")}
                value={
                  foundations == null
                    ? "—"
                    : t("solitaireReview.summary.foundationsValue", { count: foundations })
                }
                testId="review-summary-foundations"
              />
              <Stat
                label={t("solitaireReview.summary.insights")}
                value={
                  insights == null
                    ? "—"
                    : t("solitaireReview.summary.insightsValue", { count: insights })
                }
                testId="review-summary-insights"
              />
            </dl>

            {personalBest && (
              <p
                data-testid="review-personal-best"
                className="mt-3 text-[11px] leading-relaxed text-white/50"
              >
                {personalBest.comparison
                  ? personalBest.comparison.relation === "matched"
                    ? t("solitaireReview.summary.personalBestMatched", {
                        best: formatDuration(personalBest.comparison.bestMs),
                      })
                    : t("solitaireReview.summary.personalBestBehind", {
                        best: formatDuration(personalBest.comparison.bestMs),
                        delta: formatDuration(personalBest.comparison.deltaMs),
                      })
                  : personalBest.completedGames === 1
                    ? t("solitaireReview.summary.personalBestFirst")
                    : t("solitaireReview.summary.personalBestUnavailable", {
                        mode: t(`solitaireReview.modes.${data.gameKind}`),
                      })}
              </p>
            )}

            <div className="mt-4 border-t border-white/10 pt-4">
              {learning ? (
                <div data-testid="review-learning">
                  <p className="text-[10px] font-black uppercase tracking-[0.18em] text-cyan-200/75">
                    {t("solitaireReview.learning.title")}
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-white/45">
                    {t("solitaireReview.learning.description")}
                  </p>
                  <p className="mt-2 text-xs leading-relaxed text-white/60">
                    {t(learning.reasonKey)}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Link
                      href={`/learn/${learning.lessonId}`}
                      data-testid="review-academy-link"
                      className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-3 py-2 text-xs font-bold text-cyan-100 transition-colors hover:bg-cyan-300/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 motion-reduce:transition-none"
                    >
                      {t("solitaireReview.learning.lessonCta")}
                      <span aria-hidden="true">→</span>
                    </Link>
                    {learning.practiceSkillId && (
                      <Link
                        href={`/learn/practice?skill=${encodeURIComponent(learning.practiceSkillId)}`}
                        data-testid="review-practice-link"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs font-bold text-white/70 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 motion-reduce:transition-none"
                      >
                        {t("solitaireReview.learning.practiceCta")}
                        <span aria-hidden="true">→</span>
                      </Link>
                    )}
                  </div>
                </div>
              ) : (
                <p
                  data-testid="review-summary-note"
                  className="text-[11px] leading-relaxed text-white/45"
                >
                  {analysisPending
                    ? t("solitaireReview.summary.analysisPending")
                    : !analysis
                      ? t("solitaireReview.summary.analysisUnavailable")
                      : status === "complete"
                        ? t("solitaireReview.summary.noInsightsComplete")
                        : t("solitaireReview.summary.noInsightsIncomplete")}
                </p>
              )}
              <p className="mt-3 text-[10px] leading-relaxed text-white/30">
                {t("solitaireReview.summary.heuristic")}
              </p>
            </div>
          </section>
        </>
      )}
    </Shell>
  );
}
