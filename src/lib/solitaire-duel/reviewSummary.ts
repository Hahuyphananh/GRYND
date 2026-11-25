// src/lib/solitaire-duel/reviewSummary.ts
//
// PHASE 4 — THE REVIEW'S CLOSING SUMMARY.
//
// Everything here is derived from data the review already owns:
//   * the authoritative replay (foundation cards, final position);
//   * the Phase 3 engine's per-move ratings and tags;
//   * an optional same-mode history summary supplied by the caller.
//
// It deliberately does not invent a score, an accuracy percentage, a new
// progression record, or a coaching relationship that the engine cannot
// support. A highlight is a real analysed move. A learning link is a real
// Academy lesson / Practice skill selected from an engine tag.

import type { AnalysisEventTag, GameAnalysis, MoveRating } from "./analysis";
import type { ReviewGameKind } from "./review";
import { foundationCount, replayMoves } from "./rules";
import type { SolitaireDeal } from "./types";
import { isInsightRating } from "./reviewView";

/** Cards currently on the foundations at the final replayed position. */
export function reviewFoundationCount(
  deal: SolitaireDeal | null | undefined,
  moves: readonly { kind: string; move: unknown }[] | null | undefined,
): number | null {
  if (!deal || !Array.isArray(moves)) return null;
  try {
    const replayed = replayMoves({ deal, moves });
    return replayed.ok ? foundationCount(replayed.state) : null;
  } catch {
    return null;
  }
}

/** Count supported labels, not legacy brilliant/blunder payloads. */
export function meaningfulInsightCount(
  analysis: GameAnalysis | null | undefined,
): number | null {
  if (!analysis) return null;
  return analysis.perMove.reduce(
    (total, move) => total + (isInsightRating(move.rating) ? 1 : 0),
    0,
  );
}

/**
 * A highlight is a real analysed move that either carries a supported label or
 * a verified structural event. Ratings that the engine no longer emits are
 * ignored even if an old cached payload still contains one.
 */
export type ReviewHighlight = {
  /** 0-based log index, matching `analysis.perMove` and the timeline. */
  ply: number;
  rating: MoveRating;
  tags: AnalysisEventTag[];
};

const STRUCTURAL_HIGHLIGHT_TAGS: ReadonlySet<AnalysisEventTag> = new Set([
  "revealed-hidden",
  "opened-column",
  "unlocked-sequence",
  "foundation-cascade",
  "king-to-empty-column",
]);

function highlightScore(move: { rating: MoveRating; tags: AnalysisEventTag[] }): number {
  const ratingScore: Record<MoveRating, number> = {
    normal: 0,
    good: 2,
    great: 6,
    brilliant: 0,
    inaccuracy: 4,
    mistake: 6,
    blunder: 0,
  };
  let score = ratingScore[move.rating];
  if (move.tags.includes("unlocked-sequence")) score += 3;
  if (move.tags.includes("opened-column")) score += 2;
  if (move.tags.includes("revealed-hidden")) score += 1;
  if (move.tags.includes("foundation-cascade")) score += 2;
  return score;
}

/**
 * Select a small set of useful moments, strongest first, then present them in
 * play order. `limit` is intentionally small: the timeline is the full record.
 */
export function reviewHighlights(
  analysis: GameAnalysis | null | undefined,
  totalMoves: number,
  limit = 4,
): ReviewHighlight[] {
  if (!analysis || limit <= 0) return [];
  const max = Math.max(0, Math.floor(Number(totalMoves) || 0));
  if (max === 0) return [];

  const selected = analysis.perMove
    .filter(
      (move) =>
        move.ply < max &&
        (isInsightRating(move.rating) ||
          move.tags.some((tag) => STRUCTURAL_HIGHLIGHT_TAGS.has(tag))),
    )
    .map((move) => ({
      ply: move.ply,
      rating: move.rating,
      tags: move.tags,
      score: highlightScore(move),
    }))
    .filter((move) => move.score > 0)
    .sort((a, b) => b.score - a.score || a.ply - b.ply)
    .slice(0, Math.max(1, Math.floor(limit)))
    .sort((a, b) => a.ply - b.ply);

  return selected.map(({ ply, rating, tags }) => ({ ply, rating, tags }));
}

/**
 * One real Academy lesson (and optionally one Practice skill) for an engine
 * tag. These IDs are checked against the authored catalogs in the test suite;
 * there is no fallback that guesses a lesson from a rating alone.
 */
export type ReviewLearningLink = {
  lessonId: string;
  practiceSkillId: string | null;
  reasonKey: string;
};

const LEARNING_BY_TAG: Partial<Record<AnalysisEventTag, ReviewLearningLink>> = {
  "revealed-hidden": {
    lessonId: "reveal-a-card",
    practiceSkillId: "reveal-hidden-cards",
    reasonKey: "solitaireReview.learning.why.reveal",
  },
  "opened-column": {
    lessonId: "opening-columns",
    practiceSkillId: "opening-empty-columns",
    reasonKey: "solitaireReview.learning.why.open",
  },
  "unlocked-sequence": {
    lessonId: "moving-kings",
    practiceSkillId: "managing-kings",
    reasonKey: "solitaireReview.learning.why.king",
  },
  "king-to-empty-column": {
    lessonId: "moving-kings",
    practiceSkillId: "managing-kings",
    reasonKey: "solitaireReview.learning.why.king",
  },
  "foundation-cascade": {
    lessonId: "efficient-foundations",
    practiceSkillId: "efficient-foundations",
    reasonKey: "solitaireReview.learning.why.cascade",
  },
  "pulled-from-foundation": {
    lessonId: "keeping-tableau-cards",
    practiceSkillId: "keeping-tableau-cards",
    reasonKey: "solitaireReview.learning.why.keep",
  },
  "pointless-shuffle": {
    lessonId: "planning-ahead",
    practiceSkillId: "planning-ahead",
    reasonKey: "solitaireReview.learning.why.plan",
  },
  "wasted-redeal": {
    lessonId: "stock-cycles",
    practiceSkillId: "stock-cycle-planning",
    reasonKey: "solitaireReview.learning.why.stock",
  },
  "foundation-progress": {
    lessonId: "foundation-timing",
    practiceSkillId: "foundation-timing",
    reasonKey: "solitaireReview.learning.why.foundation",
  },
};

const LEARNING_TAG_ORDER: readonly AnalysisEventTag[] = [
  "revealed-hidden",
  "opened-column",
  "unlocked-sequence",
  "king-to-empty-column",
  "foundation-cascade",
  "pulled-from-foundation",
  "pointless-shuffle",
  "wasted-redeal",
  "foundation-progress",
];

/** The single most relevant lesson for this move, or null. */
export function reviewLearningFor(
  tags: readonly AnalysisEventTag[] | null | undefined,
): ReviewLearningLink | null {
  if (!Array.isArray(tags)) return null;
  for (const tag of LEARNING_TAG_ORDER) {
    if (tags.includes(tag)) return LEARNING_BY_TAG[tag] ?? null;
  }
  return null;
}

/** The first highlight that has a verified learning relationship. */
export function reviewLearningForHighlights(
  highlights: readonly ReviewHighlight[],
): ReviewLearningLink | null {
  for (const highlight of highlights) {
    const link = reviewLearningFor(highlight.tags);
    if (link) return link;
  }
  return null;
}

export type PersonalBestComparison = {
  bestMs: number;
  /** 0 means this game matched the same-mode best; positive means slower. */
  deltaMs: number;
  completedGames: number;
  relation: "matched" | "behind";
};

/**
 * Compare a completion with the all-time same-mode summary the caller already
 * fetched. A single completion is not a comparison, so it returns null.
 *
 * We deliberately do not claim "new personal best": the summary includes the
 * current game, so without a previous-best value the honest statement is
 * "personal best" (matched) or "personal best is faster".
 */
export function personalBestComparison({
  durationMs,
  bestMs,
  completedGames,
}: {
  durationMs: number | null | undefined;
  bestMs: number | null | undefined;
  completedGames: number | null | undefined;
}): PersonalBestComparison | null {
  const duration = Number(durationMs);
  const best = Number(bestMs);
  const games = Number(completedGames);
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(best) ||
    best <= 0 ||
    !Number.isFinite(games) ||
    games < 2
  ) {
    return null;
  }
  const deltaMs = Math.max(0, Math.round(duration - best));
  return {
    bestMs: Math.round(best),
    deltaMs,
    completedGames: Math.floor(games),
    relation: deltaMs === 0 ? "matched" : "behind",
  };
}

// Keeps the review kind vocabulary in one place for callers that build the
// summary without importing the page.
export type ReviewSummaryKind = ReviewGameKind;
