// src/lib/solitaire-duel/reviewView.ts
//
// Pure view-model helpers for the Game Review screen.
//
// THREE RULES LIVE HERE, so they can be tested without a browser:
//
//   1. A position is rebuilt from the canonical deal and a PREFIX of the
//      validated move log. No board snapshot is stored per move.
//   2. The rebuilt state must have consumed exactly that prefix. The view the
//      board renders is derived with `viewForState`, which is the same
//      projection the live game uses — so a face-down card still carries no
//      identity.
//   3. Navigation is clamped to [0, moves.length]: index 0 is the initial deal,
//      index n is the final position.

import type { GameAnalysis, MoveRating } from "./analysis";
import type { ReviewGameKind, ReviewStatus } from "./review";
import { replayMoves, viewForState } from "./rules";
import type { SolitaireDeal, SolitaireMove } from "./types";

export type ReviewNavigationAction = "start" | "previous" | "next" | "end";

export type ReviewPosition =
  | {
      ok: true;
      /** The authoritative replay state at this prefix. */
      state: ReturnType<typeof replayMoves>["state"];
      /** The projection the read-only board draws — never hidden identities. */
      view: ReturnType<typeof viewForState>;
    }
  | { ok: false; rejectedAt: number | null };

export function clampPly(ply: number, total: number): number {
  const max = Math.max(0, Math.floor(Number(total) || 0));
  const value = Math.floor(Number(ply) || 0);
  return Math.min(Math.max(0, value), max);
}

export function stepPly(
  current: number,
  total: number,
  action: ReviewNavigationAction,
): number {
  const max = Math.max(0, Math.floor(Number(total) || 0));
  const at = clampPly(current, max);
  if (action === "start") return 0;
  if (action === "end") return max;
  if (action === "previous") return Math.max(0, at - 1);
  return Math.min(max, at + 1);
}

/**
 * Ratings that make a move worth stopping on while skimming a review.
 *
 * The arrows exist to skip the routine log, so `normal` and `good` moves are
 * stepped over. Standout plays (great, brilliant) and the moves worth learning
 * from (inaccuracy, mistake, blunder) are the stops.
 */
export const NOTABLE_RATINGS: readonly MoveRating[] = [
  "great",
  "brilliant",
  "inaccuracy",
  "mistake",
  "blunder",
];

export function isNotableRating(rating: MoveRating | null | undefined): boolean {
  return Boolean(rating && NOTABLE_RATINGS.includes(rating));
}

/** The 1-based plies (the review's `selectedPly` scale) of notable moves. */
export function notablePlies(
  analysis: GameAnalysis | null | undefined,
  totalMoves: number,
): number[] {
  const max = Math.max(0, Math.floor(Number(totalMoves) || 0));
  if (!analysis || max === 0) return [];
  const limit = Math.min(max, analysis.perMove.length);
  const plies: number[] = [];
  for (let index = 0; index < limit; index += 1) {
    if (isNotableRating(analysis.perMove[index]?.rating)) plies.push(index + 1);
  }
  return plies;
}

/**
 * Step to the next stop instead of the next ply.
 *
 * Forward past the last stop lands on the final position, and back before the
 * first lands on the initial deal — the same ends the single-step arrows use.
 * Before the analysis arrives (or when a game has no standout move at all)
 * there is nothing to skip, so this degrades to plain one-ply stepping rather
 * than jumping across the whole game.
 */
export function stepToNotable(
  current: number,
  total: number,
  action: ReviewNavigationAction,
  notable: readonly number[],
): number {
  const max = Math.max(0, Math.floor(Number(total) || 0));
  const at = clampPly(current, max);
  if (action === "start") return 0;
  if (action === "end") return max;

  const stops = notable.filter(
    (ply) => Number.isInteger(ply) && ply > 0 && ply <= max,
  );
  if (stops.length === 0) return stepPly(at, max, action);

  if (action === "previous") {
    let target = 0;
    for (const ply of stops) if (ply < at) target = ply;
    return target;
  }

  for (const ply of stops) if (ply > at) return ply;
  return max;
}

/**
 * Rebuild the board at `ply` from the deal and the first `ply` moves.
 *
 * A log that the engine refuses (or that leaves the cursor short) is reported
 * rather than half-drawn: the review must never show a board that is not the
 * authoritative replay.
 */
export function reconstructReviewPosition(
  deal: SolitaireDeal,
  moves: readonly { kind: string; move: unknown }[],
  ply: number,
): ReviewPosition {
  const at = clampPly(ply, moves.length);
  const replayed = replayMoves({ deal, moves: moves.slice(0, at) });
  if (!replayed.ok || replayed.state.ply !== at) {
    return { ok: false, rejectedAt: replayed.rejectedAt };
  }
  return { ok: true, state: replayed.state, view: viewForState(replayed.state) };
}

export type RatingMeta = {
  label: string;
  /** The timeline chip: full class strings so Tailwind can see every colour. */
  chip: string;
  dot: string;
};

export const RATING_META: Record<MoveRating, RatingMeta> = {
  normal: {
    label: "Normal",
    chip: "border-white/10 bg-white/5 text-white/50",
    dot: "bg-white/30",
  },
  good: {
    label: "Good",
    chip: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
    dot: "bg-emerald-400",
  },
  great: {
    label: "Great",
    chip: "border-emerald-300/40 bg-emerald-300/15 text-emerald-200",
    dot: "bg-emerald-300",
  },
  brilliant: {
    label: "Brilliant",
    chip: "border-cyan-300/45 bg-cyan-300/15 text-cyan-200",
    dot: "bg-cyan-300",
  },
  inaccuracy: {
    label: "Inaccuracy",
    chip: "border-amber-300/40 bg-amber-300/10 text-amber-200",
    dot: "bg-amber-300",
  },
  mistake: {
    label: "Mistake",
    chip: "border-orange-400/40 bg-orange-400/10 text-orange-200",
    dot: "bg-orange-400",
  },
  blunder: {
    label: "Blunder",
    chip: "border-rose-400/45 bg-rose-400/10 text-rose-200",
    dot: "bg-rose-400",
  },
};

/** The engine's rating for the move at `moveIndex` (0-based), or null. */
export function ratingForMove(
  analysis: GameAnalysis | null | undefined,
  moveIndex: number,
): MoveRating | null {
  if (!analysis || moveIndex < 0) return null;
  return analysis.perMove[moveIndex]?.rating ?? null;
}

export type ReviewSummaryCounts = {
  great: number;
  brilliant: number;
  mistake: number;
  blunder: number;
};

export function summaryCounts(
  analysis: GameAnalysis | null | undefined,
): ReviewSummaryCounts | null {
  if (!analysis) return null;
  const ratings = analysis.summary.ratings;
  return {
    great: ratings.great ?? 0,
    brilliant: ratings.brilliant ?? 0,
    mistake: ratings.mistake ?? 0,
    blunder: ratings.blunder ?? 0,
  };
}

/**
 * The engine's accuracy, and ONLY where it is meaningful.
 *
 * `analysisEligible` comes from the review API and is true only for a game the
 * viewer actually completed. A partial log can still be analysed for move
 * ratings, but presenting its average as a "completion accuracy" would be a
 * different, invented claim — so an incomplete game returns null here.
 */
export function accuracyPercent({
  eligible,
  analysis,
}: {
  eligible: boolean;
  analysis: GameAnalysis | null | undefined;
}): number | null {
  if (!eligible || !analysis?.complete) return null;
  const accuracy = analysis.summary.accuracy;
  if (accuracy == null || !Number.isFinite(accuracy)) return null;
  return Math.round(accuracy * 10) / 10;
}

export const STATUS_META: Record<ReviewStatus, { label: string; chip: string }> = {
  complete: {
    label: "Complete",
    chip: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
  },
  forfeit: {
    label: "Forfeit",
    chip: "border-amber-400/40 bg-amber-400/10 text-amber-200",
  },
  incomplete: {
    label: "Incomplete",
    chip: "border-white/15 bg-white/5 text-white/60",
  },
};

export const GAME_KIND_LABEL: Record<ReviewGameKind, string> = {
  duel: "Solitaire Duel",
  solo: "Solo Solitaire",
  daily: "Daily Challenge",
};

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

function cardName(card: MoveShape["card"]): string {
  if (!card) return "card";
  const rank = RANK_LABELS[Number(card.rank)] ?? String(card.rank ?? "");
  return `${rank}${SUIT_GLYPHS[String(card.suit)] ?? ""}`;
}

function columnName(column: number | undefined): string {
  return Number.isFinite(Number(column)) ? `column ${Number(column) + 1}` : "a column";
}

function foundationName(suit: string | undefined): string {
  const glyph = SUIT_GLYPHS[String(suit)];
  return glyph ? `${glyph} foundation` : "foundation";
}

/** A short, human-readable move for the timeline. Never prose. */
export function describeMove(move: unknown): string {
  const value = (move ?? {}) as MoveShape;
  switch (value.kind) {
    case "draw":
      return "Draw from stock";
    case "waste-to-foundation":
      return `Waste \u2192 ${foundationName(value.suit)}`;
    case "waste-to-tableau":
      return `Waste \u2192 ${columnName(value.toColumn)}`;
    case "tableau-to-foundation":
      return `${cardName(value.card)} \u2192 ${foundationName(value.suit)}`;
    case "tableau-to-tableau":
      return `${cardName(value.card)}: ${columnName(value.fromColumn)} \u2192 ${columnName(value.toColumn)}`;
    case "foundation-to-tableau":
      return `${cardName(value.card)}: foundation \u2192 ${columnName(value.toColumn)}`;
    default:
      return "Move";
  }
}

export const TAG_LABELS: Record<string, string> = {
  "stock-draw": "Stock draw",
  "waste-redeal": "Waste redeal",
  "revealed-hidden": "Revealed a hidden card",
  "opened-column": "Opened a column",
  "unlocked-sequence": "Unlocked a sequence",
  "foundation-cascade": "Foundation cascade",
  "wasted-redeal": "Wasted redeal",
  "pointless-shuffle": "Pointless shuffle",
  "pulled-from-foundation": "Pulled from foundation",
  "king-to-empty-column": "King to empty column",
  "foundation-progress": "Foundation progress",
};

export function tagLabel(tag: string): string {
  return TAG_LABELS[tag] ?? "Notable move";
}

/** Type guard used by the page when it receives a raw move from the API. */
export function asMove(value: unknown): SolitaireMove | null {
  if (!value || typeof value !== "object" || typeof (value as { kind?: unknown }).kind !== "string") {
    return null;
  }
  return value as SolitaireMove;
}
