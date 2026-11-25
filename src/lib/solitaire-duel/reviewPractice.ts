// src/lib/solitaire-duel/reviewPractice.ts
//
// PHASE 3 — Game Review → Practice.
//
// A review recommendation is evidence about a decision, not a prepared board.
// This module is the whole bridge:
//
//   * `reviewPracticeSkill` maps the recommendation's OWN evidence (the gains it
//     already measured against the played move) to an existing Practice skill.
//     There is no new heuristic and no card inspection here.
//   * `reviewPracticePlan` selects the first VALIDATED exercise for that skill
//     and builds the two links. It never copies the reviewed deal, never reuses
//     the game seed and never exposes a hidden card: the returned plan carries
//     ids and URLs only.
//   * `reviewReturnPath` accepts only a same-origin review path, so the `from`
//     query parameter cannot become an open redirect.
//   * `reviewPlyFromSearch` restores the reviewed ply after that return.
//
// Falling back to an existing drill is deliberate. A reviewed mid-game position
// is not guaranteed to convert into a full, validator-approved exercise, and
// inventing one would either teach a different decision or leak hidden cards.

import type { GameAnalysis } from "./analysis";
import type { MoveRecommendation } from "./alternatives";
import { LESSON_BY_ID } from "./lessonCatalog";
import {
  practiceExercisesFor,
  practiceSkill,
  type PracticeCategoryId,
  type PracticeDifficulty,
} from "./practice";
import { recommendationForMove } from "./reviewRecommendation";

export type ReviewPracticePlan = {
  readonly skillId: string;
  readonly categoryId: PracticeCategoryId;
  readonly difficulty: PracticeDifficulty;
  readonly exerciseId: string;
  /** A real catalog lesson, or null when the concept has no lesson. */
  readonly lessonId: string | null;
  /** The exact review move to restore on return. */
  readonly reviewHref: string;
  /** The validated drill, with its review origin. */
  readonly practiceHref: string;
};

/**
 * Only real lesson ids from `lessonCatalog.ts`.
 *
 * `practicePlan` still checks `LESSON_BY_ID` before returning one, so removing a
 * lesson from the catalog degrades to "no lesson link" rather than a dead link.
 */
const LESSON_BY_SKILL: Readonly<Record<string, string>> = Object.freeze({
  "reveal-hidden-cards": "reveal-a-card",
  "opening-empty-columns": "opening-columns",
  "managing-kings": "moving-kings",
  "foundation-timing": "foundation-timing",
  "stock-cycle-planning": "stock-cycles",
  "comparing-alternative-moves": "choosing-sequences",
});

/**
 * The strategic concept behind a supported recommendation.
 *
 * Order matters because one recommendation can carry several gains; the first
 * match is the most specific teachable concept. Every branch maps to a skill
 * that has at least one validated exercise.
 */
export function reviewPracticeSkill(
  recommendation: MoveRecommendation | null | undefined,
): string | null {
  if (!recommendation) return null;
  const { evidence, move } = recommendation;

  if (evidence.foundationGain > 0) return "foundation-timing";
  if (evidence.revealsGain > 0) return "reveal-hidden-cards";
  if (move.kind === "tableau-to-tableau" && move.card.rank === 13) return "managing-kings";
  if (evidence.emptyColumnsGain > 0) return "opening-empty-columns";
  if (recommendation.played.kind === "draw" && move.kind !== "draw") {
    return "stock-cycle-planning";
  }
  return "comparing-alternative-moves";
}

/**
 * Build the practice plan for one reviewed move, or null.
 *
 * Null covers every unsupported case: no analysis, a routine/positive move, an
 * unknown recommendation, a skill without a validated exercise, an invalid
 * review path. The caller simply renders no button.
 */
export function reviewPracticePlan(args: {
  analysis: GameAnalysis | null | undefined;
  moveIndex: number;
  kind: string;
  gameId: string;
  ply: number;
}): ReviewPracticePlan | null {
  const recommendation = recommendationForMove(args.analysis, args.moveIndex);
  const skillId = reviewPracticeSkill(recommendation);
  if (!recommendation || !skillId) return null;

  const skill = practiceSkill(skillId);
  const exercise = practiceExercisesFor(skillId)[0];
  if (!skill || !exercise) return null;

  const ply =
    Number.isInteger(args.ply) && args.ply >= 0 ? args.ply : recommendation.ply + 1;
  const reviewHref = `/solitaire/review/${encodeURIComponent(
    args.kind,
  )}/${encodeURIComponent(args.gameId)}?ply=${ply}`;

  const candidateLesson = LESSON_BY_SKILL[skillId];
  const lessonId = candidateLesson && LESSON_BY_ID[candidateLesson] ? candidateLesson : null;

  const query = new URLSearchParams({
    skill: skillId,
    difficulty: exercise.difficulty,
    auto: "1",
    from: reviewHref,
  });

  return {
    skillId,
    categoryId: skill.categoryId,
    difficulty: exercise.difficulty,
    exerciseId: exercise.id,
    lessonId,
    reviewHref,
    practiceHref: `/learn/practice?${query.toString()}`,
  };
}

/**
 * Accept only a same-origin review path. Anything else returns null, so the
 * Practice page can never turn `from` into an external redirect or a lookalike
 * path. The ply is preserved; other query parameters are dropped.
 */
export function reviewReturnPath(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return null;

  let url: URL;
  try {
    url = new URL(value, "https://grynd.local");
  } catch {
    return null;
  }
  if (url.origin !== "https://grynd.local") return null;
  if (!/^\/solitaire\/review\/(solo|daily|duel)\/[A-Za-z0-9._~%-]+\/?$/.test(url.pathname)) {
    return null;
  }

  const rawPly = url.searchParams.get("ply");
  if (rawPly !== null && !/^\d{1,6}$/.test(rawPly)) return null;
  return rawPly === null ? url.pathname : `${url.pathname}?ply=${Number(rawPly)}`;
}

/** Restore a reviewed ply from a query string, clamped to the real log. */
export function reviewPlyFromSearch(search: string, totalMoves: number): number {
  if (!Number.isFinite(totalMoves) || totalMoves <= 0) return 0;
  const total = Math.floor(totalMoves);
  const raw = new URLSearchParams(search).get("ply");
  if (!raw || !/^\d{1,6}$/.test(raw)) return 0;
  return Math.min(total, Math.max(0, Number(raw)));
}
