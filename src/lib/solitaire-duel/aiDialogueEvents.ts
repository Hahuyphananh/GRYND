// src/lib/solitaire-duel/aiDialogueEvents.ts
//
// A compact, privacy-safe summary of what the practice bot did between two
// planner runs.
//
// WHERE IT RUNS: only on the server, from `advanceAiMatch`, after
// `planAiMoves` has already produced its moves. It never decides anything, never
// mutates a state and is not called by the AI, the rules engine or the move
// path.
//
// WHAT IT EXPORTS: booleans and aggregate counts ONLY. No card identity, no
// suit contents, no stock, no tableau, no planning metadata. The client can
// therefore react to "the bot opened a column" without ever learning which
// column, which card, or what it plans next.
//
// AGGREGATION: one server read can apply several bot moves. Everything below is
// aggregated across the whole batch — one reveal boolean, counts for opened
// columns and foundation gains, one king boolean — so a client can never receive
// one event per hidden move.
//
// RESET: a stalled bot board is re-dealt by the store. The caller passes
// `suppressed: true` for that tick and the summary is null; the Phase 2 director
// also clears on `resetCount`.

import type { Card, SolitaireMove, SolitaireState } from "./types";

export type AiDialogueEventSummary = {
  /** At least one face-down tableau card was exposed during the batch. */
  reveal: boolean;
  /** Cards ADDED to the foundations (a pull-back never makes this negative). */
  foundation: number;
  /** Suits whose foundation reached King during this batch. */
  foundationSuitsCompleted: number;
  /** Tableau columns that became empty at least once during the batch. */
  emptyColumnsOpened: number;
  /** A King was moved into a column that was empty at that moment. */
  kingToEmptyColumn: boolean;
  /** The bot completed the deal during this batch. */
  completed: boolean;
};

const SUITS = ["spades", "hearts", "diamonds", "clubs"] as const;
const KING_RANK = 13;
const COMPLETE_SUIT = 13;

function foundationCount(state: SolitaireState): number {
  const foundations = state.foundations ?? ({} as SolitaireState["foundations"]);
  return (
    (foundations.spades?.length ?? 0) +
    (foundations.hearts?.length ?? 0) +
    (foundations.diamonds?.length ?? 0) +
    (foundations.clubs?.length ?? 0)
  );
}

function faceDownCount(state: SolitaireState): number {
  let faceDown = 0;
  for (const column of state.tableau ?? []) {
    for (const pile of column) {
      if (!pile.faceUp) faceDown += 1;
    }
  }
  return faceDown;
}

/** A card-identity ledger. Face-down positions are `null`; lengths are exact. */
function cloneTableau(state: SolitaireState): (Card | null)[][] {
  return (state.tableau ?? []).map((column) =>
    column.map((pile) => (pile.faceUp ? pile.card : null)),
  );
}

function indexOfCard(stack: (Card | null)[], card: Card): number {
  return stack.findIndex(
    (candidate) =>
      candidate != null &&
      candidate.suit === card.suit &&
      candidate.rank === card.rank,
  );
}

/**
 * Summarize one planner batch.
 *
 * `before` and `after` are the SAME seat's state around `planAiMoves`, and
 * `moves` is exactly the sequence it returned. Returns null when there is
 * nothing safe to narrate (no moves, a re-deal tick, or a board that was
 * already complete before this batch).
 */
export function summarizeAiDialogueEvents({
  before,
  moves,
  after,
  suppressed = false,
}: {
  before: SolitaireState;
  moves: readonly SolitaireMove[];
  after: SolitaireState;
  /** True on a bot re-deal tick: the batch must not produce dialogue events. */
  suppressed?: boolean;
}): AiDialogueEventSummary | null {
  if (suppressed || before.completed || moves.length === 0) return null;

  const openedColumns = new Set<number>();
  let kingToEmptyColumn = false;

  // Replay ONLY the structural effect on column emptiness. This is a lightweight
  // ledger of card identities, not a rules re-implementation: `applyMove` already
  // accepted these moves, so the ledger only has to answer "was that column
  // empty at the moment the King landed?" across a multi-move batch.
  const stacks = cloneTableau(before);
  for (const move of moves) {
    if (move.kind === "tableau-to-tableau") {
      const source = stacks[move.fromColumn];
      const target = stacks[move.toColumn];
      if (!source || !target || move.fromColumn === move.toColumn) continue;
      const index = indexOfCard(source, move.card);
      if (index < 0) continue;
      if (target.length === 0 && move.card.rank === KING_RANK) {
        kingToEmptyColumn = true;
      }
      const run = source.splice(index);
      target.push(...run);
      if (source.length === 0) openedColumns.add(move.fromColumn);
    } else if (move.kind === "tableau-to-foundation") {
      const source = stacks[move.fromColumn];
      if (!source) continue;
      const index = indexOfCard(source, move.card);
      if (index < 0) continue;
      source.splice(index, 1);
      if (source.length === 0) openedColumns.add(move.fromColumn);
    } else if (
      move.kind === "foundation-to-tableau" ||
      move.kind === "waste-to-tableau"
    ) {
      // Adds a card to a column. The identity is irrelevant to emptiness.
      const target = stacks[move.toColumn];
      if (target) target.push(null);
    }
  }

  const beforeFoundation = foundationCount(before);
  const afterFoundation = foundationCount(after);
  const foundations = after.foundations ?? ({} as SolitaireState["foundations"]);
  const beforePiles = before.foundations ?? ({} as SolitaireState["foundations"]);

  let foundationSuitsCompleted = 0;
  for (const suit of SUITS) {
    const beforeLength = beforePiles[suit]?.length ?? 0;
    const afterLength = foundations[suit]?.length ?? 0;
    if (beforeLength < COMPLETE_SUIT && afterLength >= COMPLETE_SUIT) {
      foundationSuitsCompleted += 1;
    }
  }

  return {
    reveal: faceDownCount(before) > faceDownCount(after),
    foundation: Math.max(0, afterFoundation - beforeFoundation),
    foundationSuitsCompleted,
    emptyColumnsOpened: openedColumns.size,
    kingToEmptyColumn,
    completed: Boolean(after.completed) && !before.completed,
  };
}
