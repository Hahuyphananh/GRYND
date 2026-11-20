// src/lib/solitaire-duel/alternatives.ts
//
// PHASE 1 — THE ALTERNATIVE-MOVE RECOMMENDATION.
//
// The review already rates a move by comparing it, one ply deep, against the
// legal moves the player could see. This module turns that comparison into a
// recommendation only when the evidence is material, and it attaches the exact
// facts a reviewer needs to judge it:
//
//   * the move that was played and the suggested move;
//   * the visible board immediately BEFORE the played move;
//   * the measured score gap and the visible counts that explain it;
//   * a confidence level;
//   * an explicit `provenOptimal: false`.
//
// WHAT IT DOES NOT DO:
//
//   * It is not a rules engine. Every legality answer comes from `applyMove`,
//     and the candidate list comes from the caller (the engine's `legalMoves`).
//   * It is not a solver. The recommendation is "the best legal move this
//     visible evaluator found", never "the optimal move". The one bounded
//     lookahead the analysis already runs can CONFIRM or VETO a recommendation
//     (see `lookaheadPlayedBest`), it never proves optimality.
//   * It does not read hidden information. The board snapshot is projected with
//     `viewForState`, which erases face-down identities, and deliberately drops
//     `nextStockCard` and the stock order. No score, tag or explanation below
//     depends on a card the player had not turned over.
//
// FAIRNESS OF THE EXPLANATION: the gains below are COUNTS (foundation cards,
// face-up tableau cards, empty columns), not card identities. A move that turns
// over a hidden card is described as "one more card face-up", never by naming
// the card that was behind it.

import { applyMove, foundationCount, revealedTableauCount, viewForState } from "./rules";
import type {
  Card,
  FoundationPiles,
  SolitaireMove,
  SolitaireState,
  TableauToFoundationMove,
  TableauToTableauMove,
  ViewPileCard,
  WasteToFoundationMove,
  WasteToTableauMove,
  FoundationToTableauMove,
} from "./types";

/** The only two classifications that can carry a recommendation. */
export type RecommendableRating = "inaccuracy" | "mistake";

/**
 * `high`   — the visible comparison is material AND either clearly separated
 *            from the next-best alternative or confirmed by the bounded
 *            lookahead.
 * `medium` — the visible comparison is material but the lead is thin, or the
 *            lookahead did not run.
 *
 * There is deliberately no `low`: an uncertain position produces no
 * recommendation at all rather than a hedged one.
 */
export type RecommendationConfidence = "high" | "medium";

export type RecommendationReason =
  /** The recommended move scores strictly higher on the visible board. */
  | "higher-visible-score"
  /** It advances more cards to the foundations. */
  | "advances-foundation"
  /** It turns over more tableau cards. */
  | "reveals-a-card"
  /** It leaves more empty tableau columns available. */
  | "frees-a-column"
  /** It makes a concrete move where the played move only cycled the stock. */
  | "productive-instead-of-draw";

/**
 * The board before the reviewed move, as the player could see it.
 *
 * Face-down positions are `{ faceUp: false, card: null }` — the projection is
 * the same one the live board uses. The stock is a COUNT: neither the order nor
 * the next card is included, so this payload cannot leak a hidden identity.
 */
export type VisibleBoardSnapshot = {
  ply: number;
  tableau: ViewPileCard[][];
  waste: Card[];
  foundations: FoundationPiles;
  stockCount: number;
};

export type RecommendationEvidence = {
  /** The played move's visible-position score (engine-internal units). */
  playedScore: number;
  /** The recommended move's visible-position score (engine-internal units). */
  alternativeScore: number;
  /** `alternativeScore - playedScore`; always material for a recommendation. */
  regret: number;
  /** How far the recommended move leads the next-best OTHER alternative. */
  leadOverNextBest: number;
  /** Foundation cards gained versus the played move. Count only. */
  foundationGain: number;
  /** Tableau cards turned face-up versus the played move. Count only. */
  revealsGain: number;
  /** Empty tableau columns gained versus the played move. Count only. */
  emptyColumnsGain: number;
  /** True when the analysis's bounded lookahead also ranked it above the played move. */
  confirmedByLookahead: boolean;
  /**
   * Always false. A visible one-ply comparison plus a tiny bounded lookahead is
   * evidence, not a proof that this is the optimal move.
   */
  provenOptimal: false;
};

export type MoveRecommendation = {
  /** 0-based index of the reviewed move in the log. */
  ply: number;
  /** The move the player made, for an exact association with the timeline. */
  played: SolitaireMove;
  /** The suggested legal move from the same pre-move board. */
  move: SolitaireMove;
  /** The classification this recommendation belongs to. */
  rating: RecommendableRating;
  /** The visible position immediately before the played move. */
  before: VisibleBoardSnapshot;
  confidence: RecommendationConfidence;
  /** What the recommendation is: a found move, not a proof. */
  basis: "best-legal-move-found-by-visible-evaluator";
  why: RecommendationReason[];
  /** One short, evidence-scoped sentence. Localization happens above this layer. */
  explanation: string;
  evidence: RecommendationEvidence;
};

/** A material gap; matches the review's inaccuracy threshold. */
const MATERIAL_REGRET = 250;
/** A clear one-ply separation, matching the review's mistake threshold. */
const CLEAR_REGRET = 600;
/** How far ahead of the next alternative counts as a clear lead. */
const CLEAR_LEAD = 250;

function sameCard(a: Card | null | undefined, b: Card | null | undefined): boolean {
  return Boolean(a) && Boolean(b) && a!.suit === b!.suit && a!.rank === b!.rank;
}

/**
 * Identity comparison for moves, so "recommended the move that was played" can
 * never slip through under a differently-built object.
 */
export function sameSolitaireMove(a: SolitaireMove, b: SolitaireMove): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  switch (a.kind) {
    case "draw":
      return true;
    case "waste-to-foundation":
      return a.suit === (b as WasteToFoundationMove).suit;
    case "waste-to-tableau":
      return a.toColumn === (b as WasteToTableauMove).toColumn;
    case "tableau-to-foundation": {
      const other = b as TableauToFoundationMove;
      return (
        a.fromColumn === other.fromColumn &&
        sameCard(a.card, other.card) &&
        a.suit === other.suit
      );
    }
    case "tableau-to-tableau": {
      const other = b as TableauToTableauMove;
      return (
        a.fromColumn === other.fromColumn &&
        sameCard(a.card, other.card) &&
        a.toColumn === other.toColumn
      );
    }
    case "foundation-to-tableau":
      return a.suit === (b as FoundationToTableauMove).suit && a.toColumn === (b as FoundationToTableauMove).toColumn;
    default:
      return false;
  }
}

function copyCards(cards: readonly Card[] | null | undefined): Card[] {
  return (cards ?? []).map((card) => ({ suit: card.suit, rank: card.rank }));
}

function emptyColumnCount(state: SolitaireState): number {
  let empty = 0;
  for (const column of state.tableau ?? []) {
    if (!column || column.length === 0) empty += 1;
  }
  return empty;
}

/**
 * Project a server board to what the player could see.
 *
 * `viewForState` is the single hidden-information boundary in the codebase;
 * using it here means a face-down identity cannot reach the recommendation even
 * by accident. `nextStockCard` is intentionally not copied.
 */
export function visibleBoardSnapshot(state: SolitaireState): VisibleBoardSnapshot {
  const view = viewForState(state);
  const tableau = (view.tableau ?? []).map((column) =>
    column.map((pile) =>
      pile.faceUp
        ? ({ faceUp: true, card: { suit: pile.card.suit, rank: pile.card.rank } } as const)
        : ({ faceUp: false, card: null } as const),
    ),
  );
  return {
    ply: state.ply,
    tableau,
    waste: copyCards(view.waste),
    foundations: {
      spades: copyCards(view.foundations?.spades),
      hearts: copyCards(view.foundations?.hearts),
      diamonds: copyCards(view.foundations?.diamonds),
      clubs: copyCards(view.foundations?.clubs),
    },
    stockCount: view.stockCount ?? 0,
  };
}

/**
 * Build the recommendation for one reviewed move, or null when the evidence is
 * not strong enough.
 *
 * The caller supplies the played move, the best legal alternative the visible
 * evaluator found, both scores, and whether the analysis's bounded lookahead
 * agreed. This function never searches: all limits live in the analysis.
 */
export function buildMoveRecommendation({
  ply,
  rating,
  played,
  alternative,
  playedScore,
  alternativeScore,
  leadOverNextBest,
  state,
  lookaheadUsed = false,
  lookaheadPlayedBest = false,
}: {
  ply: number;
  rating: RecommendableRating;
  played: SolitaireMove;
  alternative: SolitaireMove;
  playedScore: number;
  alternativeScore: number;
  leadOverNextBest: number;
  /** The authoritative pre-move board (may contain hidden identities; projected). */
  state: SolitaireState;
  lookaheadUsed?: boolean;
  /** True when the bounded lookahead ranked the PLAYED move best. */
  lookaheadPlayedBest?: boolean;
}): MoveRecommendation | null {
  if (rating !== "inaccuracy" && rating !== "mistake") return null;
  if (!state || !played || !alternative) return null;
  // Never recommend the move that was played.
  if (sameSolitaireMove(played, alternative)) return null;
  // A recommendation must be strictly better on the visible comparison.
  if (!(alternativeScore > playedScore)) return null;
  const regret = alternativeScore - playedScore;
  if (regret < MATERIAL_REGRET) return null;

  // Legality is decided by the authoritative engine, in the exact pre-move
  // position. If either application fails, the evidence is unusable.
  const playedState = applyMove({ state, move: played });
  const alternativeState = applyMove({ state, move: alternative });
  if (!playedState.ok || !alternativeState.ok) return null;

  // The bounded lookahead saw one reply further and preferred what was played.
  // The one-ply claim is then not reliable enough to show.
  if (lookaheadUsed && lookaheadPlayedBest) return null;

  const foundationGain = foundationCount(alternativeState.state) - foundationCount(playedState.state);
  const revealsGain =
    revealedTableauCount(alternativeState.state) - revealedTableauCount(playedState.state);
  const emptyGain = emptyColumnCount(alternativeState.state) - emptyColumnCount(playedState.state);

  const why: RecommendationReason[] = [];
  if (foundationGain > 0) why.push("advances-foundation");
  if (revealsGain > 0) why.push("reveals-a-card");
  if (emptyGain > 0) why.push("frees-a-column");
  if (played.kind === "draw" && alternative.kind !== "draw") {
    why.push("productive-instead-of-draw");
  }
  why.push("higher-visible-score");

  const details: string[] = [];
  if (foundationGain > 0) {
    details.push(`${foundationGain} more foundation card${foundationGain === 1 ? "" : "s"}`);
  }
  if (revealsGain > 0) {
    details.push(`${revealsGain} more card${revealsGain === 1 ? "" : "s"} turned face-up`);
  }
  if (emptyGain > 0) {
    details.push(`${emptyGain} more empty column${emptyGain === 1 ? "" : "s"}`);
  }
  const detail = details.length > 0 ? ` (${details.join(", ")})` : "";

  const confirmed = lookaheadUsed && !lookaheadPlayedBest;
  const confidence: RecommendationConfidence =
    confirmed || (regret >= CLEAR_REGRET && leadOverNextBest >= CLEAR_LEAD) ? "high" : "medium";

  return {
    ply,
    played,
    move: alternative,
    rating,
    before: visibleBoardSnapshot(state),
    confidence,
    basis: "best-legal-move-found-by-visible-evaluator",
    why,
    explanation: `The best legal alternative found leads the visible-position value by ${regret}${detail}; it is not a proven optimal move.`,
    evidence: {
      playedScore,
      alternativeScore,
      regret,
      leadOverNextBest,
      foundationGain,
      revealsGain,
      emptyColumnsGain: emptyGain,
      confirmedByLookahead: confirmed,
      provenOptimal: false,
    },
  };
}
