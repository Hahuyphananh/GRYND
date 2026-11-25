// src/lib/solitaire-duel/review.ts
//
// THE SHARED SHAPE OF A GAME REVIEW.
//
// All three modes return the same top-level fields so a review client has ONE
// renderer: `gameId`, `gameKind`, `variant`, `variantVersion`, `status`, `deal`,
// `moves`, `result`, timing, and whether a full accuracy analysis is legitimate.
//
// `status` is the review's own vocabulary, not the match lifecycle:
//
//   complete   — the viewer's own board reached 52 cards on the foundations
//   forfeit    — the match ended because a seat conceded/disconnected/timed out
//   incomplete  — the match ended without the viewer's board being solved
//
// Only `complete` may be presented as a full Game Review; `analysisEligible`
// carries that as a single boolean so a caller cannot accidentally compute an
// accuracy score for a forfeit. The API never calculates analysis itself.
//
// Pure and dependency-free (no database, no auth), so both route families and
// tests share it.

import type { GameAnalysis } from "./analysis";
import type { SolitaireDeal, SolitaireMove } from "./types";

export type ReviewGameKind = "duel" | "solo" | "daily";

export type ReviewStatus = "complete" | "incomplete" | "forfeit";

export type ReviewIncompleteReason = "forfeit" | "not-completed" | null;

export type ReviewMove = {
  kind: SolitaireMove["kind"];
  move: SolitaireMove;
};

export type SolitaireReview = {
  gameId: string;
  gameKind: ReviewGameKind;
  variant: string;
  variantVersion: number;
  status: ReviewStatus;
  /** The exact server deal, so every board can be rebuilt from the log. */
  deal: SolitaireDeal;
  /** The viewer's own validated moves, oldest first. Never the opponent's. */
  moves: ReviewMove[];
  /** Mode-specific result facts (completion, seat, outcome, elapsed time). */
  result: Record<string, unknown>;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  /** True only when a full review (and therefore an accuracy figure) is valid. */
  analysisEligible: boolean;
  /**
   * The cached (or freshly computed) analysis for this exact log and engine
   * version. Optional so an older caller/fixture stays assignable; the review
   * routes always include it, and the client only falls back to its worker when
   * it is null.
   */
  analysis?: GameAnalysis | null;
  incompleteReason: ReviewIncompleteReason;
  /** Back-compat convenience for the existing solo/daily review caller. */
  mode?: "solo" | "daily";
  seed?: number;
  dateKey?: string;
};

/** ISO-8601 for a Date / timestamp-like value, or null when unreadable. */
export function toIso(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string" || typeof value === "number") {
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  return null;
}

/** Non-negative milliseconds between two ISO instants, or null. */
export function durationMsBetween(startIso: string | null, endIso: string | null): number | null {
  if (!startIso || !endIso) return null;
  const ms = Date.parse(endIso) - Date.parse(startIso);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * Review status for a duel from facts the server owns.
 *
 * A viewer who solved their own board always earns `complete`, even if the
 * match settled as a draw before the race resolved. Anything else is `forfeit`
 * when the server recorded a forfeit, and `incomplete` otherwise.
 */
export function duelReviewStatus({
  playerCompleted,
  resolutionReason,
}: {
  playerCompleted: boolean;
  resolutionReason: string | null | undefined;
}): ReviewStatus {
  if (playerCompleted) return "complete";
  return resolutionReason === "forfeit" ? "forfeit" : "incomplete";
}
