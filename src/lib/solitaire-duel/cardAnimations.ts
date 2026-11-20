// src/lib/solitaire-duel/cardAnimations.ts
//
// WHICH CARDS JUST CHANGED — the pure half of the card animation layer.
//
// The board renders whatever the server (or the local engine) projects. To
// animate a reveal or a stock draw exactly once, it has to know what actually
// changed between two snapshots — not merely that a component re-rendered. This
// module compares two authoritative views and returns a small, presentational
// plan:
//
//   * `reveals` — tableau slots that were face-DOWN and are now face-UP. The
//     card beneath them is now part of the view, so the slot can physically
//     flip instead of the face appearing instantly.
//   * `draw` — the card(s) that just left the stock for the waste. Only the
//     TOPMOST new waste card is animated: the others (a 3-card draw, or a fast
//     sequence of clicks) arrive beneath it in the fan and must not each replay
//     the draw.
//   * `redeal` — the stock was empty and has just been refilled from the waste.
//     The waste cards are returned so the caller can fly harmless card BACKS
//     back to the stock; their identities are not revealed by the animation.
//
// THE RULES THAT KEEP IT HONEST
//
//   * No previous view → no plan. A first paint, a remount or a page load never
//     animates an entire board into place.
//   * Ply unchanged, or a REWOUND position (review stepping back, undo) → no
//     plan. Animations only describe forward play.
//   * A new deal (`resetCount` changed) → no plan. That is a fresh board, not a
//     reveal.
//   * Read-only review surfaces never call this with a previous play position,
//     and the board ignores the plan entirely when `readOnly` is set.
//   * Hidden identities are never inspected: a face-down slot is compared only
//     by its `faceUp` flag, and the returned plan carries keys, not cards — the
//     exception is `redeal`, whose cards the view already exposes as waste.
//
// This module has no React and no DOM, so every rule above is unit-testable.

import type { Card, SolitaireView } from "./types";

/** A tableau slot that has just been revealed by the move above it. */
export type TableauReveal = {
  column: number;
  index: number;
  /** Stable slot id — `column:index`. */
  key: string;
};

/** The newest waste card, which performs the draw-and-flip. */
export type StockDrawAnimation = {
  /** Stable card identity — `suit-rank`. Unique within a deck. */
  cardKey: string;
};

/** Waste cards going back to the stock; only their backs are drawn. */
export type RedealAnimation = {
  /** Stable identities, in the order they appear in the waste. */
  cardKeys: string[];
};

export type CardAnimationPlan = {
  reveals: TableauReveal[];
  draw: StockDrawAnimation | null;
  redeal: RedealAnimation | null;
};

export const EMPTY_CARD_ANIMATION_PLAN: CardAnimationPlan = {
  reveals: [],
  draw: null,
  redeal: null,
};

/** `spades-12` — a card's stable identity (a deck has no duplicates). */
export function cardKey(card: Card): string {
  return `${card.suit}-${card.rank}`;
}

/** A tableau slot's stable identity: the column and the position in its fan. */
export function tableauSlotKey(column: number, index: number): string {
  return `${column}:${index}`;
}

/** Is this plan empty (nothing to animate)? */
export function isCardAnimationPlanEmpty(plan: CardAnimationPlan): boolean {
  return plan.reveals.length === 0 && !plan.draw && !plan.redeal;
}

/**
 * Compare two authoritative views and return what should animate.
 *
 * Callers pass the previous view and the new one; passing the same view twice
 * is a no-op, which is what makes an unchanged server snapshot safe.
 */
export function detectCardAnimations(
  previous: SolitaireView | null | undefined,
  next: SolitaireView | null | undefined,
): CardAnimationPlan {
  if (!previous || !next) return EMPTY_CARD_ANIMATION_PLAN;
  // Same position, or a rewind (undo / review): nothing NEW became visible.
  if (next.ply <= previous.ply) return EMPTY_CARD_ANIMATION_PLAN;
  // A redealt board is a fresh start, not a reveal.
  if (next.resetCount !== previous.resetCount) return EMPTY_CARD_ANIMATION_PLAN;

  const reveals: TableauReveal[] = [];
  next.tableau.forEach((pile, column) => {
    const before = previous.tableau[column] ?? [];
    pile.forEach((slot, index) => {
      if (!slot.faceUp || !slot.card) return;
      const was = before[index];
      // Only a slot that EXISTED and was explicitly face-down counts. A slot
      // that did not exist before is a new card arriving, never a reveal.
      if (was && was.faceUp === false) {
        reveals.push({ column, index, key: tableauSlotKey(column, index) });
      }
    });
  });

  // ── Stock draw ─────────────────────────────────────────────────────────
  // The waste is an exposed list of card identities, so a newly drawn card is
  // the one present now that was not there a moment ago. A Klondike draw of
  // three adds three; only the top one should visibly travel and flip, because
  // the other two land underneath it in the fan.
  const previousWaste = new Set(previous.waste.map(cardKey));
  const added = next.waste.filter((card) => !previousWaste.has(cardKey(card)));
  const stockDropped = next.stockCount < previous.stockCount;
  const draw: StockDrawAnimation | null =
    stockDropped && added.length > 0
      ? { cardKey: cardKey(added[added.length - 1]) }
      : null;

  // ── Redeal ─────────────────────────────────────────────────────────────
  // The stock was empty and has just taken the waste back. The engine may
  // leave the top card face-up on the waste (a redeal that immediately draws),
  // so this is detected from the stock refilling while the waste shrank —
  // never from the waste being completely empty.
  const redeal: RedealAnimation | null =
    previous.stockCount === 0 &&
    next.stockCount > 0 &&
    previous.waste.length > next.waste.length
      ? { cardKeys: previous.waste.map(cardKey) }
      : null;

  if (reveals.length === 0 && !draw && !redeal) return EMPTY_CARD_ANIMATION_PLAN;
  return { reveals, draw, redeal };
}
