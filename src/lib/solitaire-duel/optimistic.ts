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
// Four of the six move kinds touch only cards the viewer can already see, so
// they are exact. Two cannot be predicted from a client view, and are refused
// here rather than guessed:
//
//   * `draw` — the next stock card's identity is deliberately not in the view
//     (and neither is the order), so there is nothing honest to show.
//   * a move that EXPOSES a face-down card — the revealed identity is the
//     server's to name (it arrives as `revealed` in the move response). The
//     card itself is still moved here; the exposed position simply stays
//     face-down until the snapshot lands.
//
// A refused prediction is normal, never an error: the caller keeps the
// authoritative board on screen and the move is still sent. Nothing in this
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
  if (move.kind === "draw") return null;

  const tableau: ViewPileCard[][] = (view.tableau ?? []).map((column) =>
    column.map((pile) => ({ ...pile })),
  );
  const waste: Card[] = (view.waste ?? []).map((card) => ({ ...card }));
  const foundations = {
    spades: (view.foundations?.spades ?? []).map((card) => ({ ...card })),
    hearts: (view.foundations?.hearts ?? []).map((card) => ({ ...card })),
    diamonds: (view.foundations?.diamonds ?? []).map((card) => ({ ...card })),
    clubs: (view.foundations?.clubs ?? []).map((card) => ({ ...card })),
  };
  let stockCount = Math.max(0, Math.trunc(Number(view.stockCount) || 0));

  if (move.kind === "waste-to-foundation") {
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

/** True for the one kind this module deliberately never predicts. */
export function isPredictable(move: SolitaireMove | null | undefined): boolean {
  return Boolean(move) && move!.kind !== "draw";
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
