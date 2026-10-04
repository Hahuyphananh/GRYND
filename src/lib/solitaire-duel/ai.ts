// src/lib/solitaire-duel/ai.ts
//
// The Solitaire Duel practice bot. PURE: it is handed the server's board and
// returns ONE legal Klondike move, or null when the board is stuck. No
// database, no clock, no I/O.
//
// The bot solves its OWN copy of the shared deal, exactly as a human seat does.
// It is not a turn-based opponent in the usual sense — Solitaire Duel is
// simultaneous — so the store paces it from the server clock (one move every
// `aiMoveDelayMs`) and the store is what guarantees it always plays.
//
// WHY A HEURISTIC RATHER THAN A SEARCH: Klondike's state space is far too large
// for a full search inside a request, and a bot that took minutes per move would
// be unplayable. The heuristic below is the standard strong-greedy order a good
// human uses:
//
//   1. put a card on a foundation   (the only move that makes permanent progress)
//   2. reveal a face-down card      (more information, more legal moves)
//   3. empty a tableau column       (frees a King slot)
//   4. otherwise draw / redeal      (surfacing a usable card)
//
// The tier only changes how often the bot takes its best move (the shared
// `AI_SKILL` slip), and how long it waits between moves — so `easy` is both
// slower and sloppier, which is what actually makes it beatable.

import { chooseAiOption, coerceAiDifficulty, type AiDifficulty } from "../aiDifficulty";
import { SUITS } from "./constants";
import {
  applyMove,
  canPlaceOnTableau,
  faceUpRunFrom,
  foundationExpects,
  sameCard,
  tableauTop,
} from "./rules";
import type { Card, SolitaireMove, SolitaireState, Suit } from "./types";

/**
 * How long the bot "thinks" between moves, per tier.
 *
 * Measured from GO: the bot is allowed `floor(elapsed / delay)` moves, so a
 * slower tier simply solves the same deal later. Chosen against a typical
 * ~150-250 move solve so `hard` finishes well inside the 600 s limit, `normal`
 * usually does, and `easy` often does not (leaving it to the progress
 * tiebreak) — which is exactly the spread a difficulty picker promises.
 */
export const AI_MOVE_DELAY_MS: Record<AiDifficulty, number> = {
  easy: 1_300,
  normal: 850,
  hard: 480,
};

/** The delay for a tier, defaulting to the shared `normal` tier. */
export function aiMoveDelayMs(difficulty: unknown): number {
  return AI_MOVE_DELAY_MS[coerceAiDifficulty(difficulty)];
}

/** Every legal move for `state` (never a move `applyMove` would reject). */
export function legalMoves(state: SolitaireState): SolitaireMove[] {
  const moves: SolitaireMove[] = [];
  if (!state || state.completed) return moves;
  const tableau = state.tableau ?? [];

  // 1. Tableau top → foundation.
  for (let column = 0; column < tableau.length; column += 1) {
    const top = tableauTop(state, column);
    if (!top?.faceUp || !top.card) continue;
    if (top.card.rank === foundationExpects(state, top.card.suit)) {
      moves.push({
        kind: "tableau-to-foundation",
        fromColumn: column,
        card: top.card,
        suit: top.card.suit,
      });
    }
  }

  // 2. Waste top → foundation / tableau.
  const wasteTop = state.waste?.[state.waste.length - 1];
  if (wasteTop) {
    if (wasteTop.rank === foundationExpects(state, wasteTop.suit)) {
      moves.push({ kind: "waste-to-foundation", suit: wasteTop.suit });
    }
    for (let column = 0; column < tableau.length; column += 1) {
      const top = tableauTop(state, column);
      if (top && !top.faceUp) continue;
      if (canPlaceOnTableau(wasteTop, top?.card ?? null)) {
        moves.push({ kind: "waste-to-tableau", toColumn: column });
      }
    }
  }

  // 3. Tableau run → another column.
  for (let from = 0; from < tableau.length; from += 1) {
    const column = tableau[from];
    for (let index = 0; index < column.length; index += 1) {
      const pile = column[index];
      if (!pile.faceUp || !pile.card) continue;
      const run = faceUpRunFrom(state, from, pile.card);
      if (!run) continue;
      for (let to = 0; to < tableau.length; to += 1) {
        if (to === from) continue;
        const top = tableauTop(state, to);
        if (top && !top.faceUp) continue;
        if (canPlaceOnTableau(run[0], top?.card ?? null)) {
          moves.push({
            kind: "tableau-to-tableau",
            fromColumn: from,
            card: pile.card,
            toColumn: to,
          });
        }
      }
    }
  }

  // 4. Foundation → tableau (rarely useful, but legal Klondike).
  for (const suit of SUITS) {
    const pile = state.foundations?.[suit] ?? [];
    const card = pile[pile.length - 1];
    if (!card) continue;
    for (let column = 0; column < tableau.length; column += 1) {
      const top = tableauTop(state, column);
      if (top && !top.faceUp) continue;
      if (canPlaceOnTableau(card, top?.card ?? null)) {
        moves.push({ kind: "foundation-to-tableau", suit, toColumn: column });
      }
    }
  }

  // 5. Draw / redeal — always available while there is anything to turn over.
  if ((state.stock?.length ?? 0) > 0 || (state.waste?.length ?? 0) > 0) {
    moves.push({ kind: "draw" });
  }

  return moves;
}

/** The face-down card directly beneath a movable run head, if any. */
function hiddenCardBelow(state: SolitaireState, column: number, head: Card) {
  const col = state.tableau?.[column];
  if (!col) return null;
  const index = col.findIndex((pile) => pile.faceUp && sameCard(pile.card, head));
  if (index <= 0) return null;
  return col[index - 1];
}

/** True when some card can immediately go onto a foundation. */
function foundationMoveExists(state: SolitaireState): boolean {
  const tableau = state.tableau ?? [];
  for (let column = 0; column < tableau.length; column += 1) {
    const top = tableauTop(state, column);
    if (top?.faceUp && top.card && top.card.rank === foundationExpects(state, top.card.suit)) {
      return true;
    }
  }
  const wasteTop = state.waste?.[state.waste.length - 1];
  return Boolean(wasteTop && wasteTop.rank === foundationExpects(state, wasteTop.suit));
}

/** True when some move would turn a face-down tableau card face-up. */
function revealMoveExists(state: SolitaireState): boolean {
  const tableau = state.tableau ?? [];
  for (let from = 0; from < tableau.length; from += 1) {
    const column = tableau[from];
    for (let index = 1; index < column.length; index += 1) {
      const head = column[index];
      const below = column[index - 1];
      if (!head.faceUp || !head.card || below.faceUp) continue;
      const run = faceUpRunFrom(state, from, head.card);
      if (!run) continue;
      for (let to = 0; to < tableau.length; to += 1) {
        if (to === from) continue;
        const top = tableauTop(state, to);
        if (top && !top.faceUp) continue;
        if (canPlaceOnTableau(run[0], top?.card ?? null)) return true;
      }
    }
  }
  return false;
}

/**
 * Whether a rearrangement actually unlocks something.
 *
 * A tableau-to-tableau move that reveals nothing and frees nothing is only
 * worth making if, AFTER it, some card can go to a foundation or some card can
 * be revealed. This one-ply lookahead is what separates a productive shuffle
 * from the aimless back-and-forth that would otherwise cycle forever.
 */
function enablesProgress(state: SolitaireState, move: SolitaireMove): boolean {
  const applied = applyMove({ state, move });
  if (!applied.ok) return false;
  const next = applied.state as SolitaireState;
  return next.completed || foundationMoveExists(next) || revealMoveExists(next);
}

/**
 * How good a move is. Higher is better; the scale is arbitrary but the ORDER is
 * the strategy. A move that merely shuffles cards between columns scores below
 * `draw`, so the bot prefers to keep turning the stock rather than oscillate.
 */
export function scoreMove(state: SolitaireState, move: SolitaireMove): number {
  switch (move.kind) {
    case "tableau-to-foundation": {
      let score = 1_000;
      const below = hiddenCardBelow(state, move.fromColumn, move.card);
      if (below && !below.faceUp) score += 200; // flips a hidden card
      const column = state.tableau?.[move.fromColumn] ?? [];
      if (column.length === 1) score += 150; // empties the column
      return score;
    }
    case "waste-to-foundation":
      return 950;
    case "waste-to-tableau": {
      const top = tableauTop(state, move.toColumn);
      // A King parked on an empty column is a real, permanent gain.
      return top ? 700 : 730;
    }
    case "tableau-to-tableau": {
      const column = state.tableau?.[move.fromColumn] ?? [];
      const index = column.findIndex((pile) => pile.faceUp && sameCard(pile.card, move.card));
      if (index < 0) return 40;
      const below = index > 0 ? column[index - 1] : null;
      const targetTop = tableauTop(state, move.toColumn);
      // Moving a whole column onto an empty column changes nothing — refuse to
      // treat it as progress so the bot cannot loop.
      if (index === 0 && !targetTop) return 0;
      if (below && !below.faceUp) return 600; // reveals a hidden card
      if (index === 0 && targetTop) return 500; // frees the source column
      // A shuffle that reveals nothing and frees nothing ranks below drawing,
      // so the bot keeps turning the stock first — but it is still available
      // (and promoted) when it unlocks a foundation or a reveal.
      return enablesProgress(state, move) ? 58 : 52;
    }
    case "foundation-to-tableau":
      // Pulling a card back off a foundation makes no permanent progress.
      return 5;
    case "draw":
    default: {
      // Drawing a NEW card is real progress (it may surface a usable card).
      // Turning an exhausted waste back over is the last resort: it ranks below
      // every deliberate move, and the planner's stagnation guard bounds it, so
      // a deal that simply cannot be advanced ends instead of cycling forever.
      const stockLeft = state.stock?.length ?? 0;
      return stockLeft > 0 ? 60 : 20;
    }
  }
}

/** A monotone "how far along is this board" key, for the stagnation guard. */
function progressKey(state: SolitaireState): number {
  let faceDown = 0;
  for (const column of state.tableau ?? []) {
    for (const pile of column) if (!pile.faceUp) faceDown += 1;
  }
  return foundationCountOf(state) * 1_000 + faceDown;
}

/** Cards on the foundations, locally (keeps this module free of store deps). */
function foundationCountOf(state: SolitaireState): number {
  const f = state.foundations ?? ({} as SolitaireState["foundations"]);
  return (
    (f.spades?.length ?? 0) +
    (f.hearts?.length ?? 0) +
    (f.diamonds?.length ?? 0) +
    (f.clubs?.length ?? 0)
  );
}

/**
 * The bot's next move, or null when the board has none.
 *
 * `random` is injectable so the tier behaviour is testable. The result is
 * ALWAYS a member of `legalMoves(state)` — a slip only picks a lower-scoring
 * legal move, never an illegal one.
 */
export function chooseAiMove({
  state,
  difficulty = "normal",
  random = Math.random,
}: {
  state: SolitaireState;
  difficulty?: unknown;
  random?: () => number;
}): SolitaireMove | null {
  const moves = legalMoves(state);
  if (moves.length === 0) return null;
  const scored = moves.map((move) => ({ move, score: scoreMove(state, move) }));
  const chosen = chooseAiOption(
    coerceAiDifficulty(difficulty),
    scored,
    (option) => option.score,
    random,
  );
  return chosen?.move ?? moves[0];
}

/**
 * How many moves in a row that change nothing before the planner gives up.
 *
 * A full stock pass is 24 draws; several unproductive passes in a row mean the
 * deal cannot be advanced by this strategy, so the bot stops instead of cycling
 * the same stock for the rest of the match. Generous enough that a genuine but
 * slow rearrangement is never cut short.
 */
export const AI_STAGNATION_LIMIT = 72;

/**
 * Plan the bot's moves from `state`, up to `maxMoves`.
 *
 * This is what the store runs each read: it applies the bot's own heuristic in
 * one pass and returns the sequence — so the store only has to persist the
 * result. The planner stops when the board is solved, when no legal move
 * remains, or when a long run of moves has changed nothing (an un-winnable
 * deal). It never mutates `state`.
 */
export function planAiMoves({
  state,
  difficulty = "normal",
  maxMoves = 64,
  random = Math.random,
}: {
  state: SolitaireState;
  difficulty?: unknown;
  maxMoves?: number;
  random?: () => number;
}): { moves: SolitaireMove[]; state: SolitaireState; completed: boolean; stuck: boolean } {
  const moves: SolitaireMove[] = [];
  let current = state;
  let best = progressKey(current);
  let stagnant = 0;
  // `stuck` means the planner stopped because the BOARD has nothing left to
  // give — no legal move at all, or a long run of moves that changed nothing.
  // It deliberately stays false when the loop merely hit `maxMoves`: a bot that
  // is simply behind schedule on the clock is not stuck. The store re-deals a
  // bot board only on `stuck && !completed`.
  let stuck = false;

  while (moves.length < Math.max(1, Math.floor(maxMoves)) && !current.completed) {
    const move = chooseAiMove({ state: current, difficulty, random });
    if (!move) {
      stuck = true;
      break;
    }
    const applied = applyMove({ state: current, move });
    if (!applied.ok) {
      stuck = true;
      break;
    }
    current = applied.state as SolitaireState;
    moves.push(move);

    const key = progressKey(current);
    if (key > best) {
      best = key;
      stagnant = 0;
    } else {
      stagnant += 1;
      if (stagnant >= AI_STAGNATION_LIMIT) {
        stuck = true;
        break;
      }
    }
  }

  return { moves, state: current, completed: Boolean(current.completed), stuck };
}

/** The suit of the top waste card, exposed for tests and diagnostics. */
export function wasteTopSuit(state: SolitaireState): Suit | null {
  const top = state.waste?.[state.waste.length - 1];
  return top ? top.suit : null;
}
