// src/lib/solitaire-duel/optimistic.ts
//
// Draw the player's own move BEFORE the server answers.
//
// The race view is authoritative: every card it shows came from a server
// snapshot, and a move is only real once the store has accepted it. That makes
// a move wait for a round trip, which a player feels as "the board verifies
// every click". This module removes the WAIT without weakening the authority:
// it rewrites the viewer's own projected board for the move that was just made,
// so the card lands on the pile the instant it is released, and the server's
// snapshot replaces the whole board moments later.
//
// ── WHAT CAN AND CANNOT BE PREDICTED ────────────────────────────────────
//
// Every move kind touches only cards the viewer can already see, so each is
// exact — including `draw`, because the view carries the ONE card the next draw
// would turn over (`nextStockCard`). That peek is what makes a stock click
// instant; the order behind it is still the server's alone.
//
// What cannot be exact is a move that EXPOSES a face-down card: the revealed
// identity is the server's to name (it arrives as `revealed` in the move
// response). The card itself is still moved here; the exposed position simply
// stays face-down until the snapshot lands.
//
// A refused prediction is normal, never an error: `applyMoveToView` returns
// null, the caller keeps the authoritative board on screen, and the move is
// still sent. Nothing in this
// module decides legality, progress for the match, completion or a winner —
// `completed` stays false even when the last card lands, because only the
// store may finish a race.

import { KING } from "./constants";
import type {
  Card,
  SolitaireMove,
  SolitaireView,
  ViewPileCard,
} from "./types";

function sameCard(a: Card | null | undefined, b: Card | null | undefined): boolean {
  return Boolean(a) && Boolean(b) && a!.suit === b!.suit && a!.rank === b!.rank;
}

function foundationCount(view: SolitaireView): number {
  return (
    (view.foundations?.spades?.length ?? 0) +
    (view.foundations?.hearts?.length ?? 0) +
    (view.foundations?.diamonds?.length ?? 0) +
    (view.foundations?.clubs?.length ?? 0)
  );
}

function revealedCount(tableau: ViewPileCard[][]): number {
  let revealed = 0;
  for (const column of tableau) for (const pile of column) if (pile.faceUp) revealed += 1;
  return revealed;
}

/** Build the next view, or null when this move cannot be predicted. */
export function applyMoveToView(
  view: SolitaireView | null | undefined,
  move: SolitaireMove | null | undefined,
): SolitaireView | null {
  if (!view || !move) return null;

  const tableau: ViewPileCard[][] = (view.tableau ?? []).map((column) =>
    column.map((pile) => ({ ...pile })),
  );
  // A redeal empties the waste and refills the stock, so this is replaced.
  let waste: Card[] = (view.waste ?? []).map((card) => ({ ...card }));
  const foundations = {
    spades: (view.foundations?.spades ?? []).map((card) => ({ ...card })),
    hearts: (view.foundations?.hearts ?? []).map((card) => ({ ...card })),
    diamonds: (view.foundations?.diamonds ?? []).map((card) => ({ ...card })),
    clubs: (view.foundations?.clubs ?? []).map((card) => ({ ...card })),
  };
  let stockCount = Math.max(0, Math.trunc(Number(view.stockCount) || 0));
  let nextStockCard = view.nextStockCard ? { ...view.nextStockCard } : null;

  if (move.kind === "draw") {
    if (stockCount > 0) {
      // The view carries exactly one card ahead; only that draw is predicted.
      // After it, the next identity is unknown until the snapshot lands.
      if (!nextStockCard) return null;
      waste.push(nextStockCard);
      stockCount -= 1;
      nextStockCard = null;
    } else if (waste.length > 0) {
      // Redeal: the stock becomes the reversed waste, so the next draw is the
      // waste's FIRST card — which is already visible, hence exactly known.
      nextStockCard = waste[0] ? { ...waste[0] } : null;
      stockCount = waste.length;
      waste = [];
    } else {
      return null;
    }
  } else if (move.kind === "waste-to-foundation") {
    const card = waste.pop();
    if (!card || card.suit !== move.suit) return null;
    foundations[move.suit].push(card);
  } else if (move.kind === "waste-to-tableau") {
    const card = waste.pop();
    const target = tableau[move.toColumn];
    if (!card || !target) return null;
    target.push({ faceUp: true, card });
  } else if (move.kind === "foundation-to-tableau") {
    const card = foundations[move.suit]?.pop();
    const target = tableau[move.toColumn];
    if (!card || !target) return null;
    target.push({ faceUp: true, card });
  } else if (move.kind === "tableau-to-foundation") {
    const column = tableau[move.fromColumn];
    const top = column?.[column.length - 1];
    if (!column || !top?.faceUp || !top.card) return null;
    if (!sameCard(top.card, move.card)) return null;
    column.pop();
    foundations[move.suit].push({ ...move.card });
  } else if (move.kind === "tableau-to-tableau") {
    const from = tableau[move.fromColumn];
    const to = tableau[move.toColumn];
    if (!from || !to) return null;
    const index = from.findIndex((pile) => pile.faceUp && sameCard(pile.card, move.card));
    if (index < 0) return null;
    const run = from.splice(index);
    if (run.length === 0 || run.some((pile) => !pile.faceUp || !pile.card)) return null;
    to.push(...run);
  } else {
    return null;
  }

  // A stock/waste pair with an empty stock can still be recycled, so the
  // redeal affordance has to follow the optimistic waste too.
  return {
    ...view,
    tableau,
    waste,
    foundations,
    stockCount,
    nextStockCard,
    ply: (Number(view.ply) || 0) + 1,
    progress: {
      foundationCards: foundationCount({ ...view, foundations }),
      revealedTableau: revealedCount(tableau),
      progressPercent: 0,
    },
    // Only the store may declare a race finished.
    completed: false,
    canRedeal: stockCount === 0 && waste.length > 0,
  };
}

/**
 * True when a move is worth drawing ahead. Every kind is attempted now that a
 * draw carries its one-card peek; `applyMoveToView` still returns null when a
 * particular prediction has no honest board to draw (a draw whose peek has not
 * arrived, a stale card), and the caller falls back to the authoritative view.
 */
export function isPredictable(move: SolitaireMove | null | undefined): boolean {
  return Boolean(move);
}

/** A face-down card that an optimistic move just exposed stays hidden. */
export function exposesHiddenCard(view: SolitaireView, move: SolitaireMove): boolean {
  if (move.kind !== "tableau-to-foundation" && move.kind !== "tableau-to-tableau") return false;
  const column = view?.tableau?.[move.fromColumn] ?? [];
  const index = column.findIndex((pile) => pile.faceUp && sameCard(pile.card, move.card));
  if (index <= 0) return false;
  return !column[index - 1].faceUp;
}

/** Exported for the moves that put a King on an empty column (UI copy only). */
export const OPTIMISTIC_KING = KING;
