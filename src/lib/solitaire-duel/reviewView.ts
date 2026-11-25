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

import type {
  AnalysisEventTag,
  GameAnalysis,
  MoveAlternative,
  MoveRating,
} from "./analysis";
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

/** Labels the Phase 3 review is willing to display. */
export const INSIGHT_RATINGS: readonly MoveRating[] = [
  "great",
  "good",
  "inaccuracy",
  "mistake",
];

export type InsightRating = Exclude<MoveRating, "normal" | "brilliant" | "blunder">;

/** True only for a rating the review can support with a visible comparison. */
export function isInsightRating(
  rating: MoveRating | null | undefined,
): rating is InsightRating {
  return Boolean(rating && INSIGHT_RATINGS.includes(rating));
}

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
  good: number;
  inaccuracy: number;
  mistake: number;
};

export function summaryCounts(
  analysis: GameAnalysis | null | undefined,
): ReviewSummaryCounts | null {
  if (!analysis) return null;
  const ratings = analysis.summary.ratings;
  return {
    great: ratings.great ?? 0,
    good: ratings.good ?? 0,
    inaccuracy: ratings.inaccuracy ?? 0,
    mistake: ratings.mistake ?? 0,
  };
}

/**
 * The plain-language facts behind one annotated move.
 *
 * All prose is derived from tags and the best visible alternative the engine
 * actually recorded. There is no prose for an unlabelled move, and no claim
 * that a labelled move would have won or lost the game.
 */
export type ReviewInsight = {
  rating: InsightRating;
  label: string;
  /** What the player did, in the same vocabulary as the timeline. */
  played: string;
  /** Engine facts, kept as codes so the page can localize the prose. */
  tags: AnalysisEventTag[];
  /** The strongest legal alternative, when one was recorded. */
  bestAlternative: MoveAlternative | null;
  /** Facts that definitely happened on the replayed board. */
  facts: string[];
  /** Why those facts affect the next choices. */
  why: string;
  /** The strongest legal alternative, labelled by the visible comparison. */
  alternative: string | null;
  /** A short, visibly-scoped lesson. */
  lesson: string | null;
  /** Always present: separates a heuristic comparison from a proof. */
  basis: string;
};

const INSIGHT_FACT_TEXT: Partial<Record<AnalysisEventTag, string>> = {
  "revealed-hidden": "The move turned a face-down tableau card face-up.",
  "opened-column": "It emptied the source column, so the column can hold a King or a sequence.",
  "king-to-empty-column": "It moved a King into an empty column.",
  "foundation-cascade": "It created more than one immediate foundation opportunity.",
  "unlocked-sequence": "A King-led sequence could now use an empty column.",
  "foundation-progress": "It moved a card to its foundation.",
  "pulled-from-foundation": "It took a card back off its foundation.",
  "pointless-shuffle":
    "It moved a tableau card without revealing a new card or freeing a column.",
  "wasted-redeal":
    "It recycled the waste while a productive visible move was available.",
};

function insightWhy(tags: readonly AnalysisEventTag[], rating: InsightRating): string {
  if (tags.includes("revealed-hidden") || tags.includes("opened-column")) {
    return "More exposed cards and reusable columns widen the legal moves available next.";
  }
  if (tags.includes("unlocked-sequence") || tags.includes("king-to-empty-column")) {
    return "An empty column is a reusable resource; where a King-led sequence goes can change future mobility.";
  }
  if (tags.includes("pulled-from-foundation")) {
    return "Foundation progress is real, but a card kept in the tableau can still support a sequence.";
  }
  if (tags.includes("pointless-shuffle") || tags.includes("wasted-redeal")) {
    return "The visible board changed, but the move did not expose a card or free a column.";
  }
  if (tags.includes("foundation-progress")) {
    return "Advancing a card is concrete progress; whether it was the best use of the turn depends on the tableau it leaves behind.";
  }
  return rating === "great" || rating === "good"
    ? "The visible-position comparison ranked it above the other legal moves."
    : "The visible-position comparison ranked another legal move above it.";
}

function insightLesson(tags: readonly AnalysisEventTag[]): string | null {
  if (tags.includes("revealed-hidden")) {
    return "Look for a move that exposes a hidden card before spending a turn on a shuffle.";
  }
  if (tags.includes("opened-column") || tags.includes("unlocked-sequence") || tags.includes("king-to-empty-column")) {
    return "Treat an empty column as a resource: use it when a King-led sequence gains more than it gives up.";
  }
  if (tags.includes("pulled-from-foundation") || tags.includes("foundation-progress")) {
    return "A foundation card is safe progress, but check whether the tableau still needs it for a sequence.";
  }
  if (tags.includes("pointless-shuffle") || tags.includes("wasted-redeal")) {
    return "Before recycling or shuffling, compare the visible moves and ask which one changes the board.";
  }
  return null;
}

/**
 * Build the compact insight for the selected move, or null when the engine did
 * not label it. `moveIndex` is 0-based; the review selects it with `ply - 1`.
 */
export function reviewInsightForMove(
  analysis: GameAnalysis | null | undefined,
  moveIndex: number,
  move: unknown,
): ReviewInsight | null {
  if (!analysis || !Number.isInteger(moveIndex) || moveIndex < 0) return null;
  const entry = analysis.perMove[moveIndex];
  if (!entry || !isInsightRating(entry.rating)) return null;

  const facts = entry.tags
    .map((tag) => INSIGHT_FACT_TEXT[tag])
    .filter((text): text is string => Boolean(text));
  if (facts.length === 0) {
    facts.push(
      entry.rating === "great" || entry.rating === "good"
        ? "The engine ranked it above the other legal moves."
        : "The engine ranked a legal alternative above it.",
    );
  }

  const alt = entry.bestAlternative;
  let alternative: string | null = null;
  if (alt) {
    const altMove = describeMove(alt.move);
    if (alt.relation === "higher-ranked") {
      alternative = `${altMove} was legal from the same visible board. The engine's visible-position comparison ranked it above the move played; that is evidence, not proof it would have won.`;
    } else if (alt.relation === "equal-ranked") {
      alternative = `${altMove} was legal and ranked equally by the visible-position comparison.`;
    } else {
      alternative = `${altMove} was the strongest other legal move; the visible-position comparison ranked it below the move played.`;
    }
  }

  return {
    rating: entry.rating,
    label: RATING_META[entry.rating].label,
    played: describeMove(move),
    tags: [...entry.tags],
    bestAlternative: alt ?? null,
    facts,
    why: insightWhy(entry.tags, entry.rating),
    alternative,
    lesson: insightLesson(entry.tags),
    basis:
      "Visible-board heuristic: it compares legal moves that were actually available. It is not a solver proof, an optimal-move claim, or an accuracy score.",
  };
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
