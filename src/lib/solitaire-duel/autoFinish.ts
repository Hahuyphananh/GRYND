// src/lib/solitaire-duel/autoFinish.ts
//
// THE AUTO-FINISH CHECK. Pure: given the authoritative board, decide whether the
// rest of the game is a formality — and if it is, hand back the exact moves.
//
// WHY THIS IS NOT "uncovered tableau + empty stock". Those are necessary, never
// sufficient: a fully uncovered board can still need a King moved to an empty
// column, or a run shuffled, before anything else will reach a foundation. So
// the engine PLAYS the finish: repeatedly sending any tableau top that is the
// next card of its suit's foundation, and stopping the moment no such card
// exists. Only a board that reaches all 52 cards that way is eligible, which is
// exactly the situation where the player has no decision left to make.
//
// The plan is therefore a real, legal sequence in the shared engine's own
// vocabulary (`tableau-to-foundation`), never a synthetic shortcut: replaying it
// (the store, a test, a resumed session) produces the same completed board.
//
// It deliberately does NOT use the stock or the waste. A waste card that still
// has to be drawn, or a stock that still has to be cycled, means a player could
// still choose an order — so that board stays manual.

import { applyMove, foundationExpects, tableauTop } from "./rules";
import type { Card, SolitaireMove, SolitaireState, Suit } from "./types";

export type AutoFinishStep = {
  move: SolitaireMove;
  card: Card;
  suit: Suit;
  fromColumn: number;
};

export type AutoFinishPlan = {
  steps: AutoFinishStep[];
  /** The completed board, reached by replaying `steps` through `applyMove`. */
  finalState: SolitaireState;
};

/** The hard ceiling for the whole finish animation. */
export const AUTO_FINISH_MAX_MS = 5_000;

/**
 * The remaining safe foundation moves, or null when the player must keep playing.
 *
 * Null is the answer for every ambiguous case: cards still face down, a stock or
 * waste that still needs turning, or a sequence that dead-ends before 52 cards.
 */
export function autoFinishPlan(
  state: SolitaireState | null | undefined,
): AutoFinishPlan | null {
  if (!state || state.completed) return null;
  if ((state.stock?.length ?? 0) > 0) return null;
  if ((state.waste?.length ?? 0) > 0) return null;

  const tableau = state.tableau ?? [];
  // Any hidden card means information the player has not earned yet, and a
  // tableau move may still be needed to expose it.
  for (const column of tableau) {
    for (const pile of column) if (!pile.faceUp || !pile.card) return null;
  }

  let current = state;
  const steps: AutoFinishStep[] = [];

  // 51 cards can move at most (the last one completes the board); the guard is
  // belt-and-braces, never a rule.
  for (let guard = 0; guard <= 52; guard += 1) {
    let moved = false;
    for (let column = 0; column < current.tableau.length; column += 1) {
      const top = tableauTop(current, column);
      if (!top?.faceUp || !top.card) continue;
      if (top.card.rank !== foundationExpects(current, top.card.suit)) continue;
      const move: SolitaireMove = {
        kind: "tableau-to-foundation",
        fromColumn: column,
        card: top.card,
        suit: top.card.suit,
      };
      const applied = applyMove({ state: current, move });
      if (!applied.ok) continue;
      current = applied.state;
      steps.push({
        move,
        card: { ...top.card },
        suit: top.card.suit,
        fromColumn: column,
      });
      moved = true;
    }
    if (current.completed) break;
    if (!moved) break;
  }

  if (!current.completed || steps.length === 0) return null;
  return { steps, finalState: current };
}

/** Convenience for the UI: is a finish available on this board? */
export function canAutoFinish(state: SolitaireState | null | undefined): boolean {
  return autoFinishPlan(state) !== null;
}
