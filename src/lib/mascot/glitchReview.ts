// src/lib/mascot/glitchReview.ts
//
// GLITCH AS A SOLITAIRE COACH — the reaction a completed game's review panel
// may show for one move.
//
// Same split as glitchMoments.ts and glitchOnboarding.ts: the DECISION lives
// here (which move deserves a line, which expression, which translation key,
// which stable event id); the WORDS live in appTextTranslations under
// `glitch.review.*` (en / fr / es). No component writes a sentence.
//
// ── WHAT MAY BE COMMENTED ON ──────────────────────────────────────────────
//
// ONLY what the engine actually recorded. A reaction exists for:
//
//   * brilliant moves
//   * great moves
//   * mistakes
//   * blunders
//   * a SMALL number of structural events (an unlocked King-led run, or two
//     foundation plays created at once) that the engine rated neither good nor
//     bad — at most GLITCH_REVIEW_MAX_STRUCTURE per game
//
// Everything else is silent: normal moves, routine card placement, stock
// draws, waste redeals, ordinary waste movements, every `good` move, and every
// `inaccuracy` (the player already gets the timeline chip for those; the mascot
// does not pile on).
//
// ── NO INVENTED EXPLANATIONS ──────────────────────────────────────────────
//
// The message family is chosen from the tags the analysis emitted for THAT
// move, never from the move's kind alone and never from a template that
// mentions something that did not happen. A `great` move with no structural
// tag cannot receive the "you opened a column" line, because that family is
// only reachable through the `opened-column` tag.
//
// ── REPETITION ────────────────────────────────────────────────────────────
//
// Every family has three wordings. They rotate by how many times that family
// has already produced a reaction IN THE SAME GAME, so two (or three) similar
// events never read identically. A fourth similar event starts the rotation
// again rather than going silent — a review is explicit about its moves, and a
// repeated line is a better failure than no line at all.
//
// Each reaction carries a STABLE event id built from the game key, the 1-based
// move number and the event type. The review has one reaction per move, keyed
// by ply, so navigating back and forth can never stack duplicates: selecting a
// Normal move shows nothing, and selecting a previous commentary move shows the
// SAME reaction again (that is the revisit the review is for).
//
// NOTHING HERE IS GENERATIVE. No LLM, no network, no clock, no randomness: the
// same analysis always produces the same reactions, which is what lets this run
// in the browser and be asserted by the tests.

import type { AnalysisEventTag, MoveRating } from "../solitaire-duel/analysis";
import type { GlitchExpression } from "./glitchAssets";

/** One move's engine output, as far as commentary is concerned. */
export type GlitchReviewMove = {
  /** 0-based index in the move log. */
  ply: number;
  rating: MoveRating;
  tags: readonly AnalysisEventTag[];
  /** The engine's own eligibility flag, when present. */
  commentaryEligible?: boolean;
};

/** The analysis shape this module reads. `GameAnalysis` satisfies it. */
export type GlitchReviewAnalysis =
  | { perMove?: readonly GlitchReviewMove[] | null }
  | null
  | undefined;

/** Inline reactions never float, so priority is only ordering metadata. */
export type GlitchReviewPriority = 1 | 2;

export type GlitchReviewTone = "praise" | "caution" | "observation";

export type GlitchReviewReaction = {
  /** Stable: the game, the 1-based move number and the event type. */
  readonly eventId: string;
  /** Dotted path into appTextTranslations. */
  readonly messageKey: string;
  readonly expression: GlitchExpression;
  readonly priority: GlitchReviewPriority;
  /** 1-based move number, the number the review panel shows. */
  readonly moveNumber: number;
  /** 0-based index in the move log. */
  readonly ply: number;
  readonly tone: GlitchReviewTone;
  /** Stable event type, e.g. `great.opened`. */
  readonly event: string;
};

type ReviewFamily = {
  readonly prefix: string;
  readonly event: string;
  readonly expression: GlitchExpression;
  readonly priority: GlitchReviewPriority;
  readonly tone: GlitchReviewTone;
};

/** How many wordings each family owns. Must match the translation bundles. */
export const GLITCH_REVIEW_VARIANTS = 3;

/** Structural events get a line only this many times per game. */
export const GLITCH_REVIEW_MAX_STRUCTURE = 2;

/**
 * Every family, with the expression the artwork catalog actually offers.
 *
 *   surprised  — an exceptional move
 *   victory    — a strong move worth celebrating
 *   focused    — a strategic observation or a gentle correction
 *   defeat     — a major error
 */
const FAMILIES = {
  brilliantUnlock: {
    prefix: "glitch.review.brilliant.unlock",
    event: "brilliant.unlock",
    expression: "surprised",
    priority: 2,
    tone: "praise",
  },
  brilliant: {
    prefix: "glitch.review.brilliant.generic",
    event: "brilliant.generic",
    expression: "surprised",
    priority: 2,
    tone: "praise",
  },
  greatOpened: {
    prefix: "glitch.review.great.opened",
    event: "great.opened",
    expression: "victory",
    priority: 2,
    tone: "praise",
  },
  greatUnlocked: {
    prefix: "glitch.review.great.unlocked",
    event: "great.unlocked",
    expression: "focused",
    priority: 2,
    tone: "praise",
  },
  greatCascade: {
    prefix: "glitch.review.great.cascade",
    event: "great.cascade",
    expression: "victory",
    priority: 2,
    tone: "praise",
  },
  greatReveal: {
    prefix: "glitch.review.great.reveal",
    event: "great.reveal",
    expression: "focused",
    priority: 2,
    tone: "praise",
  },
  greatFoundation: {
    prefix: "glitch.review.great.foundation",
    event: "great.foundation",
    expression: "victory",
    priority: 2,
    tone: "praise",
  },
  great: {
    prefix: "glitch.review.great.generic",
    event: "great.generic",
    expression: "focused",
    priority: 2,
    tone: "praise",
  },
  mistakeFoundation: {
    prefix: "glitch.review.mistake.foundation",
    event: "mistake.foundation",
    expression: "focused",
    priority: 1,
    tone: "caution",
  },
  mistakeShuffle: {
    prefix: "glitch.review.mistake.shuffle",
    event: "mistake.shuffle",
    expression: "focused",
    priority: 1,
    tone: "caution",
  },
  mistake: {
    prefix: "glitch.review.mistake.generic",
    event: "mistake.generic",
    expression: "focused",
    priority: 1,
    tone: "caution",
  },
  blunderFoundation: {
    prefix: "glitch.review.blunder.foundation",
    event: "blunder.foundation",
    expression: "defeat",
    priority: 2,
    tone: "caution",
  },
  blunder: {
    prefix: "glitch.review.blunder.generic",
    event: "blunder.generic",
    expression: "defeat",
    priority: 2,
    tone: "caution",
  },
  structureSequence: {
    prefix: "glitch.review.structure.sequence",
    event: "structure.sequence",
    expression: "focused",
    priority: 1,
    tone: "observation",
  },
  structureCascade: {
    prefix: "glitch.review.structure.cascade",
    event: "structure.cascade",
    expression: "focused",
    priority: 1,
    tone: "observation",
  },
} as const satisfies Record<string, ReviewFamily>;

const FAMILY_LIST: readonly ReviewFamily[] = Object.freeze(
  Object.values(FAMILIES) as ReviewFamily[],
);

/**
 * Every key this module owns — asserted in all three locales by the tests.
 * Variant 1 is the bare prefix; variants 2 and 3 add their number.
 */
export const GLITCH_REVIEW_KEYS: readonly string[] = Object.freeze(
  FAMILY_LIST.flatMap((family) =>
    Array.from({ length: GLITCH_REVIEW_VARIANTS }, (_, index) =>
      index === 0 ? family.prefix : `${family.prefix}${index + 1}`,
    ),
  ),
);

function hasTag(move: GlitchReviewMove, tag: AnalysisEventTag): boolean {
  return Array.isArray(move.tags) && move.tags.includes(tag);
}

/**
 * The family for a rating-eligible move, or null when the engine did not rate
 * it as commentary-worthy.
 *
 * The tag order below is the order of specificity: a `great` move that opened a
 * column gets the column line even if it also flipped a card, because opening
 * the column is the larger structural fact and the copy cannot claim both.
 */
function familyForRating(move: GlitchReviewMove): ReviewFamily | null {
  switch (move.rating) {
    case "brilliant":
      return hasTag(move, "opened-column") && hasTag(move, "unlocked-sequence")
        ? FAMILIES.brilliantUnlock
        : FAMILIES.brilliant;

    case "great":
      if (hasTag(move, "opened-column")) return FAMILIES.greatOpened;
      if (hasTag(move, "unlocked-sequence")) return FAMILIES.greatUnlocked;
      if (hasTag(move, "foundation-cascade")) return FAMILIES.greatCascade;
      if (hasTag(move, "revealed-hidden")) return FAMILIES.greatReveal;
      if (hasTag(move, "foundation-progress")) return FAMILIES.greatFoundation;
      return FAMILIES.great;

    case "mistake":
      if (hasTag(move, "pulled-from-foundation")) return FAMILIES.mistakeFoundation;
      if (hasTag(move, "pointless-shuffle")) return FAMILIES.mistakeShuffle;
      return FAMILIES.mistake;

    case "blunder":
      if (hasTag(move, "pulled-from-foundation")) return FAMILIES.blunderFoundation;
      return FAMILIES.blunder;

    default:
      // normal / good / inaccuracy are silent on rating alone.
      return null;
  }
}

/**
 * A structural event worth a coach's line on an otherwise unremarkable move.
 *
 * Deliberately narrow: only the two rarest, most consequential structural tags,
 * only on a move the engine rated neither good nor bad, and only when the move
 * is not already eligible by rating. A routine reveal, a stock draw, a waste
 * move and a pointless shuffle all fall through to null.
 */
function familyForStructure(move: GlitchReviewMove): ReviewFamily | null {
  if (move.rating !== "normal") return null;
  if (hasTag(move, "unlocked-sequence")) return FAMILIES.structureSequence;
  if (hasTag(move, "foundation-cascade")) return FAMILIES.structureCascade;
  return null;
}

/** Variant 1 is the bare prefix; later variants add their 1-based number. */
function messageKeyFor(family: ReviewFamily, seen: number): string {
  const variant = seen % GLITCH_REVIEW_VARIANTS;
  return variant === 0 ? family.prefix : `${family.prefix}${variant + 1}`;
}

function isUsableMove(move: GlitchReviewMove | null | undefined): move is GlitchReviewMove {
  return Boolean(
    move &&
      typeof move === "object" &&
      Number.isInteger(move.ply) &&
      move.ply >= 0 &&
      typeof move.rating === "string" &&
      Array.isArray(move.tags),
  );
}

/**
 * Build every reaction for one game, keyed by 0-based ply.
 *
 * Pure and deterministic. The review page memoises the result per analysis, so
 * changing the selected move only performs a Map lookup.
 */
export function buildGlitchReviewReactions({
  analysis,
  gameKey,
}: {
  analysis: GlitchReviewAnalysis;
  gameKey: string | null | undefined;
}): ReadonlyMap<number, GlitchReviewReaction> {
  const reactions = new Map<number, GlitchReviewReaction>();
  if (!analysis || !Array.isArray(analysis.perMove)) return reactions;

  const key = typeof gameKey === "string" ? gameKey.trim() : "";
  if (key === "") return reactions;

  // Play order, copied: the analysis array is never mutated or reordered.
  const moves = [...analysis.perMove].filter(isUsableMove).sort((a, b) => a.ply - b.ply);

  // Per-family variant counters, and the structural budget for this game.
  const seenByFamily = new Map<string, number>();
  let structureUsed = 0;

  for (const move of moves) {
    // The engine's own flag wins when it says this move is not coach-worthy.
    // (Structural events are `commentaryEligible: false` by definition, so the
    // flag only gates the rating families.)
    let family: ReviewFamily | null = null;
    if (move.commentaryEligible === false) {
      family = null;
    } else {
      family = familyForRating(move);
    }

    if (!family) {
      if (structureUsed >= GLITCH_REVIEW_MAX_STRUCTURE) continue;
      family = familyForStructure(move);
      if (family) structureUsed += 1;
    }

    if (!family) continue;

    const seen = seenByFamily.get(family.prefix) ?? 0;
    seenByFamily.set(family.prefix, seen + 1);

    const moveNumber = move.ply + 1;
    reactions.set(move.ply, {
      eventId: `review:${key}:${moveNumber}:${family.event}`,
      messageKey: messageKeyFor(family, seen),
      expression: family.expression,
      priority: family.priority,
      moveNumber,
      ply: move.ply,
      tone: family.tone,
      event: family.event,
    });
  }

  return reactions;
}

/**
 * The reaction for one selected move, or null when the move is silent.
 *
 * `ply` is 0-based (the review page's `selectedPly - 1`). Index 0 is the
 * initial deal and is never a move; it always returns null.
 */
export function selectGlitchReviewReaction({
  analysis,
  gameKey,
  ply,
}: {
  analysis: GlitchReviewAnalysis;
  gameKey: string | null | undefined;
  ply: number;
}): GlitchReviewReaction | null {
  if (!Number.isInteger(ply) || ply < 0) return null;
  return buildGlitchReviewReactions({ analysis, gameKey }).get(ply) ?? null;
}
