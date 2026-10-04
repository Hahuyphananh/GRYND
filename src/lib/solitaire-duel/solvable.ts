// src/lib/solitaire-duel/solvable.ts
//
// HARD-BUT-SOLVABLE deal generation for Solitaire Duel.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────
//
// A pure Fisher–Yates shuffle produces an unsolvable board roughly a fifth of
// the time. In a 1v1 race that is not a "hard deal" — it is a match that can
// never be finished by solving, so it has to be decided by the inactivity
// forfeit twenty minutes later. That is a bad match for BOTH players.
//
// The first answer to that was `constructedDealFromSeed` (the version-2 walk,
// retained below): build the won position in reverse so the deal is provably
// solvable. It solved the fairness problem and created a worse one — the board
// was trivially easy. That construction put every Ace–6 in the stock in the
// exact order the foundations wanted them and made every tableau column an
// already-complete descending run, so a player could solve the whole puzzle by
// drawing and placing without a single decision. The cards were, in the user's
// words, "basically laid out for them".
//
// ── THE METHOD: RANDOM DEAL + VERIFIED WITNESS + DIFFICULTY GATE ────────
//
// This module now deals a genuine random Klondike board (the v1 shuffle) and
// only serves it when TWO things are true:
//
//   1. SOLVABLE — a deterministic search finds a real winning line, and that
//      line is REPLAYED through the authoritative engine (`./rules.ts`) before
//      it is trusted. A deal is never called solvable on the strength of the
//      search's own bookkeeping; the engine has to accept every move.
//
//   2. NOT LAID OUT — the naive "take any foundation card, otherwise turn the
//      stock" strategy FAILS. That is the exact strategy the shipped deals used
//      to be solvable by, so refusing it is what guarantees this generator can
//      never regress to the trivial board. A player has to build tableau runs,
//      uncover face-down cards and plan an order.
//
// About four in five random Klondike deals are winnable, and a human wins only a
// fraction of those — which is exactly the target: never impossible, never
// handed over, and genuinely capable of stalling a player mid-board.
//
// ── THE SEARCH: SINGLE-CARD DRAW IS A POOL ──────────────────────────────
//
// The variant has a single-card draw and UNLIMITED redeals (see `./constants`).
// That makes the stock and waste behave as one unordered POOL: from any position
// the player can cycle the stock as many times as they like, so any stock or
// waste card is reachable whenever they want it. The search below therefore
// treats every stock/waste card as immediately playable, which removes the
// stock ORDER from the state space entirely and is what makes the search small
// enough to run inside a request.
//
// The reduction is exact in both directions: a pool line is realisable in the
// real game by inserting the draws that cycle the wanted card to the waste top
// (`replayActions` does exactly that), and any real game is trivially a pool
// line. The witness is replayed through the engine, so even if this reasoning
// were wrong somewhere, an unsolvable deal could not slip through — it would
// fail the replay and be rejected.
//
// ── DETERMINISM ─────────────────────────────────────────────────────────
//
// Both the shuffle and the search are driven from one `mulberry32` stream
// derived from the match seed, so the served deal is a pure function of that
// seed. Re-rolling a seed whose deal is unsolvable (or too easy) draws the next
// attempt's seed from the same stream, so a given match seed always produces the
// same served deal, in every runtime.

import { mulberry32 } from "../physics2d/deterministic";
import {
  DECK_SIZE,
  KING,
  RED_SUITS,
  STOCK_SIZE,
  SUITS,
  TABLEAU_CARDS,
  TABLEAU_COLUMNS,
  VARIANT,
  VARIANT_VERSION,
} from "./constants";
import { dealFromSeed } from "./deck";
import {
  applyMove,
  cloneState,
  foundationExpects,
  initialStateFromDeal,
  isComplete,
  sameCard,
  tableauTop,
} from "./rules";
import type {
  Card,
  PileCard,
  Rank,
  SolitaireDeal,
  SolitaireMove,
  SolitaireState,
  Suit,
} from "./types";

// ──────────────────────────────────────────────────────────────────────────
// Search tuning
// ──────────────────────────────────────────────────────────────────────────

/**
 * Nodes (post-normalisation positions) one attempt may visit before it is
 * abandoned and the next seed is drawn.
 *
 * Measured against the sampled seeds: roughly half of random deals are proven
 * within this budget, and the generator only needs ONE proven deal, so a
 * handful of cheap attempts beats one expensive one. Raising this trades match
 * latency for a slightly higher per-attempt hit rate.
 */
const ATTEMPT_NODE_BUDGET = 6_000;

/**
 * The most deal seeds tried before falling back.
 *
 * At the measured per-attempt hit rate the chance that all of them fail is
 * vanishingly small (well under one in a million), and the fallback below is
 * itself solvable, so a match can never be dealt an unsolvable board.
 */
const MAX_ATTEMPTS = 24;

/**
 * A hard ceiling on search work across ALL attempts of one call.
 *
 * Bounds the worst case (a pathological run of unsolvable seeds) so generating
 * a match can never run away, independent of how the per-attempt hit rate moves
 * if this file is tuned later.
 */
const TOTAL_NODE_BUDGET = 120_000;

// ──────────────────────────────────────────────────────────────────────────
// The retained v2 construction — kept so version-2 rows stay reproducible
// ──────────────────────────────────────────────────────────────────────────

/** Hearts and diamonds are red. Local so this module keeps importing little. */
function isRed(suit: Suit): boolean {
  return (RED_SUITS as readonly string[]).includes(suit);
}

/**
 * The lowest rank the v2 tableau may hold.
 *
 * The v2 tableau took ranks 7..13 of every suit (7 × 4 = 28) and the stock took
 * ranks 1..6 (6 × 4 = 24). That split is what let the stock be drawn in one
 * ascending pass and every tableau card be exactly one rank from its
 * foundation afterwards. It is also precisely what made the deal trivial.
 */
const V2_TABLEAU_FLOOR = 7;

/** A placement during the v2 reverse walk: one card, at one rank, of one suit. */
type V2Placed = { suit: Suit; rank: Rank };

/** Fisher–Yates over a copy, driven by the seeded stream. */
function shuffleWith<T>(items: T[], rand: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const swap = out[i];
    out[i] = out[j];
    out[j] = swap;
  }
  return out;
}

/**
 * Walk the game backwards from the won position to a standard 1..7 opening.
 *
 * Returns the seven columns (bottom→top) or null if this seed's stream could
 * not reach the exact opening shape within the node budget.
 */
function reverseWalk(rand: () => number): V2Placed[][] | null {
  const ATTEMPTS = 8;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const walked = walkOnce(rand);
    if (walked) return walked;
  }
  return null;
}

/**
 * One reverse pass, with the columns' FINAL SIZES chosen up front.
 *
 * Committing to a target size per column (a permutation of 1..7) makes the walk
 * cheap: total capacity is exactly 28, so a pass that never overfills a column
 * finishes with every column at exactly its target. That leaves only the COLOUR
 * rule to satisfy, a small matching problem (four suits onto four distinct
 * columns) the backtracking below solves directly.
 */
function walkOnce(rand: () => number): V2Placed[][] | null {
  const columns: V2Placed[][] = Array.from({ length: TABLEAU_COLUMNS }, () => []);
  const targets = shuffleWith(
    Array.from({ length: TABLEAU_COLUMNS }, (_, index) => index + 1),
    rand,
  );
  let nodes = 0;
  const NODE_BUDGET = 20_000;

  function placeRank(rank: number): boolean {
    if (rank < V2_TABLEAU_FLOOR) return true;
    if (++nodes > NODE_BUDGET) return false;

    const suits = shuffleWith([...SUITS], rand);
    const used = new Set<number>();

    function placeSuit(index: number): boolean {
      if (index === suits.length) return placeRank(rank - 1);
      const suit = suits[index];
      const candidates: number[] = [];
      for (let column = 0; column < columns.length; column += 1) {
        if (used.has(column)) continue;
        if (columns[column].length >= targets[column]) continue;
        const pile = columns[column];
        if (pile.length === 0) {
          // An empty column accepts any rank: forward, `tableau-to-foundation`
          // never inspects what is beneath the card it takes.
          candidates.push(column);
          continue;
        }
        const top = pile[pile.length - 1];
        if (top.rank === rank + 1 && isRed(top.suit) !== isRed(suit)) {
          candidates.push(column);
        }
      }
      candidates.sort(
        (a, b) => targets[b] - columns[b].length - (targets[a] - columns[a].length),
      );
      for (const column of candidates) {
        columns[column].push({ suit, rank: rank as Rank });
        used.add(column);
        if (placeSuit(index + 1)) return true;
        used.delete(column);
        columns[column].pop();
      }
      return false;
    }

    return placeSuit(0);
  }

  if (!placeRank(KING)) return null;
  return columns;
}

/** The v2 stock, bottom→top, so the next draw is the LAST element. */
function v2Stock(): Card[] {
  const drawOrder: Card[] = [];
  for (let rank = 1; rank <= V2_TABLEAU_FLOOR - 1; rank += 1) {
    for (const suit of SUITS) drawOrder.push({ suit, rank: rank as Rank });
  }
  return drawOrder.reverse();
}

/**
 * The version-2 deal: a GUARANTEED-SOLVABLE construction, and the board that
 * was too easy.
 *
 * Retained verbatim (semantically) so a stored `VARIANT_VERSION` 2 row can
 * still be rebuilt from its seed, exactly as `dealFromSeed` is retained for v1.
 * It is no longer served: `solvableDealFromSeed` is the version-3 generator, and
 * this is only the fallback of last resort if the search cannot prove ANY random
 * deal solvable (which has never been observed).
 */
export function constructedDealFromSeed(seed: number): SolitaireDeal {
  const rand = mulberry32(seed);
  const walked = reverseWalk(rand);

  if (!walked) return dealFromSeed(seed);

  const ordered = walked.slice().sort((a, b) => a.length - b.length);
  const tableau: PileCard[][] = ordered.map((pile) =>
    pile.map((placed, index) => ({
      card: { suit: placed.suit, rank: placed.rank },
      faceUp: index === pile.length - 1,
    })),
  );

  return {
    variant: VARIANT,
    variantVersion: VARIANT_VERSION,
    tableau,
    stock: v2Stock(),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// The naive "laid out" solver — the difficulty gate
// ──────────────────────────────────────────────────────────────────────────

/**
 * Solve by the simplest possible strategy: take any card that fits a
 * foundation, otherwise turn the stock over. Never a tableau-to-tableau move.
 *
 * This is the exact strategy the v2 constructed deals were solvable by, so a
 * deal that this solves is a deal whose cards are "laid out". The generator
 * refuses those. Returns the move count, or null when the deal stalls.
 */
export function greedySolveDeal(deal: SolitaireDeal): number | null {
  let state = initialStateFromDeal(deal);
  const MOVE_LIMIT = 4_000;

  for (let move = 0; move < MOVE_LIMIT; move += 1) {
    if (isComplete(state)) return move;

    // 1. The top of any column that fits its foundation.
    let placed = false;
    for (let column = 0; column < state.tableau.length; column += 1) {
      const top = tableauTop(state, column);
      if (!top?.faceUp || !top.card) continue;
      if (top.card.rank !== foundationExpects(state, top.card.suit)) continue;
      const applied = applyMove({
        state,
        move: {
          kind: "tableau-to-foundation",
          fromColumn: column,
          card: top.card,
          suit: top.card.suit,
        },
      });
      if (applied.ok) {
        state = applied.state;
        placed = true;
        break;
      }
    }
    if (placed) continue;

    // 2. The top of the waste.
    const wasteTop = state.waste[state.waste.length - 1];
    if (wasteTop && wasteTop.rank === foundationExpects(state, wasteTop.suit)) {
      const applied = applyMove({ state, move: { kind: "waste-to-foundation", suit: wasteTop.suit } });
      if (applied.ok) {
        state = applied.state;
        continue;
      }
    }

    // 3. Turn a card over (draw, or redeal the waste).
    if (state.stock.length > 0 || state.waste.length > 0) {
      const applied = applyMove({ state, move: { kind: "draw" } });
      if (applied.ok) {
        state = applied.state;
        continue;
      }
    }

    // Nothing fits and nothing is left to turn over: the deal has stalled.
    return null;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────
// The strong solver — compact pool-reduction search
// ──────────────────────────────────────────────────────────────────────────

const SUIT_INDEX: Record<Suit, number> = { spades: 0, hearts: 1, diamonds: 2, clubs: 3 };

/** A card index, `suit * 13 + (rank - 1)`, so a card is one small integer. */
const cardIndex = (card: Card): number => SUIT_INDEX[card.suit] * 13 + (card.rank - 1);
const indexSuit = (index: number): Suit => SUITS[Math.floor(index / 13)] as Suit;
const indexRank = (index: number): Rank => ((index % 13) + 1) as Rank;
const indexIsRed = (index: number): boolean => isRed(indexSuit(index));

/** A compact column: card indices bottom→top, with a parallel face-up mask. */
type CompactColumn = { cards: number[]; faceUp: boolean[] };

/**
 * The search position.
 *
 * `pool` is every card still in the stock or waste (their ORDER is deliberately
 * gone — see the header). `foundations` is the per-suit count of cards played.
 */
type CompactState = {
  columns: CompactColumn[];
  pool: number[];
  foundations: number[];
};

/** One move in the compact game, in the order it was taken. */
type SolveAction =
  | { t: "tf"; from: number } // tableau column top → foundation
  | { t: "tt"; from: number; card: number; to: number } // tableau run → tableau
  | { t: "pf"; card: number } // pool card → foundation
  | { t: "pt"; card: number; to: number }; // pool card → tableau

function compactFromDeal(deal: SolitaireDeal): CompactState {
  return {
    columns: deal.tableau.map((column) => ({
      cards: column.map((pile) => cardIndex(pile.card as Card)),
      faceUp: column.map((pile) => pile.faceUp),
    })),
    pool: deal.stock.map(cardIndex),
    foundations: [0, 0, 0, 0],
  };
}

function cloneCompact(state: CompactState): CompactState {
  return {
    columns: state.columns.map((column) => ({ cards: column.cards.slice(), faceUp: column.faceUp.slice() })),
    pool: state.pool.slice(),
    foundations: state.foundations.slice(),
  };
}

const foundationTotal = (state: CompactState): number =>
  state.foundations[0] + state.foundations[1] + state.foundations[2] + state.foundations[3];

function revealedTotal(state: CompactState): number {
  let total = 0;
  for (const column of state.columns) for (const faceUp of column.faceUp) if (faceUp) total += 1;
  return total;
}

function emptyColumnTotal(state: CompactState): number {
  let total = 0;
  for (const column of state.columns) if (column.cards.length === 0) total += 1;
  return total;
}

/**
 * Play every immediately-available foundation card, recording each as an
 * action, and flip any card a removal exposes.
 *
 * This is the standard "foundation moves are free" reduction: a card on a
 * foundation can be taken back off it in real Klondike, so for the question
 * "is this deal winnable at all" it never helps to leave one sitting in a
 * column. Greedily clearing them shrinks the state space enormously.
 */
function normalize(state: CompactState, actions: SolveAction[]): void {
  let changed = true;
  while (changed) {
    changed = false;

    for (let column = 0; column < state.columns.length; column += 1) {
      const col = state.columns[column];
      while (col.cards.length > 0 && col.faceUp[col.faceUp.length - 1]) {
        const card = col.cards[col.cards.length - 1];
        const suit = Math.floor(card / 13);
        if (indexRank(card) !== state.foundations[suit] + 1) break;
        state.foundations[suit] += 1;
        col.cards.pop();
        col.faceUp.pop();
        actions.push({ t: "tf", from: column });
        if (col.cards.length > 0 && !col.faceUp[col.faceUp.length - 1]) {
          col.faceUp[col.faceUp.length - 1] = true;
        }
        changed = true;
      }
    }

    let fromPool = true;
    while (fromPool) {
      fromPool = false;
      for (let index = 0; index < state.pool.length; index += 1) {
        const card = state.pool[index];
        const suit = Math.floor(card / 13);
        if (indexRank(card) === state.foundations[suit] + 1) {
          state.foundations[suit] += 1;
          state.pool.splice(index, 1);
          actions.push({ t: "pf", card });
          fromPool = true;
          changed = true;
          break;
        }
      }
    }
  }
}

/** Whether `card` may be laid on a column whose top index is `top`. */
function compactCanPlace(card: number, top: number | null): boolean {
  if (top === null) return indexRank(card) === KING;
  return indexRank(card) === indexRank(top) - 1 && indexIsRed(card) !== indexIsRed(top);
}

/** The face-up descending alternating run from `start` to a column's top. */
function compactRunValid(col: CompactColumn, start: number): boolean {
  if (!col.faceUp[start]) return false;
  for (let index = start; index < col.cards.length - 1; index += 1) {
    if (!col.faceUp[index + 1]) return false;
    if (indexRank(col.cards[index]) !== indexRank(col.cards[index + 1]) + 1) return false;
    if (indexIsRed(col.cards[index]) === indexIsRed(col.cards[index + 1])) return false;
  }
  return true;
}

/** Every non-foundation move available in the pool game. */
function compactMoves(state: CompactState): SolveAction[] {
  const moves: SolveAction[] = [];

  for (let from = 0; from < state.columns.length; from += 1) {
    const col = state.columns[from];
    for (let start = 0; start < col.cards.length; start += 1) {
      if (!compactRunValid(col, start)) continue;
      const head = col.cards[start];
      for (let to = 0; to < state.columns.length; to += 1) {
        if (to === from) continue;
        const target = state.columns[to];
        const top = target.cards.length > 0 ? target.cards[target.cards.length - 1] : null;
        if (top !== null && !target.faceUp[target.faceUp.length - 1]) continue;
        if (!compactCanPlace(head, top)) continue;
        // Moving an entire column onto an empty column changes nothing.
        if (start === 0 && top === null) continue;
        moves.push({ t: "tt", from, card: head, to });
      }
    }
  }

  for (const card of state.pool) {
    for (let to = 0; to < state.columns.length; to += 1) {
      const target = state.columns[to];
      const top = target.cards.length > 0 ? target.cards[target.cards.length - 1] : null;
      if (top !== null && !target.faceUp[target.faceUp.length - 1]) continue;
      if (!compactCanPlace(card, top)) continue;
      moves.push({ t: "pt", card, to });
    }
  }

  return moves;
}

function applyCompact(state: CompactState, action: SolveAction): CompactState {
  const next = cloneCompact(state);
  if (action.t === "tt") {
    const source = next.columns[action.from];
    const start = source.cards.indexOf(action.card);
    const moving = source.cards.splice(start);
    source.faceUp.splice(start);
    for (const card of moving) {
      next.columns[action.to].cards.push(card);
      next.columns[action.to].faceUp.push(true);
    }
    if (source.cards.length > 0 && !source.faceUp[source.faceUp.length - 1]) {
      source.faceUp[source.faceUp.length - 1] = true;
    }
  } else if (action.t === "pt") {
    next.pool.splice(next.pool.indexOf(action.card), 1);
    next.columns[action.to].cards.push(action.card);
    next.columns[action.to].faceUp.push(true);
  }
  return next;
}

/** A canonical key for the visited set. The pool is implied by the rest. */
function compactKey(state: CompactState): string {
  let key = `${state.foundations[0]},${state.foundations[1]},${state.foundations[2]},${state.foundations[3]}|`;
  for (const column of state.columns) {
    for (let index = 0; index < column.cards.length; index += 1) {
      key += `${column.cards[index]}${column.faceUp[index] ? "u" : "d"},`;
    }
    key += "|";
  }
  return key;
}

/**
 * Depth-first search over the pool game, best-progress move first.
 *
 * Only moves that make visible progress (a foundation gain, a newly revealed
 * card, or a freed column) are expanded — that single restriction is what keeps
 * the branching small enough to run in a request, and it is also the shape of
 * strong human play. Returns the winning action sequence, or null.
 */
function search(deal: SolitaireDeal, counter: { nodes: number }, limit: number): SolveAction[] | null {
  const seen = new Set<string>();

  function dfs(state: CompactState): SolveAction[] | null {
    const lead: SolveAction[] = [];
    normalize(state, lead);
    if (foundationTotal(state) === DECK_SIZE) return lead;

    counter.nodes += 1;
    if (counter.nodes > limit) return null;

    const key = compactKey(state);
    if (seen.has(key)) return null;
    seen.add(key);

    const foundationsBefore = foundationTotal(state);
    const revealedBefore = revealedTotal(state);
    const emptiesBefore = emptyColumnTotal(state);

    const candidates: { state: CompactState; actions: SolveAction[]; score: number }[] = [];
    for (const move of compactMoves(state)) {
      const next = applyCompact(state, move);
      const actions: SolveAction[] = [move];
      normalize(next, actions);

      const gained = foundationTotal(next) - foundationsBefore;
      const revealed = revealedTotal(next) - revealedBefore;
      const emptied = emptyColumnTotal(next) - emptiesBefore;
      if (gained <= 0 && revealed <= 0 && emptied <= 0) continue;

      const score =
        gained * 1_000_000 +
        revealed * 10_000 +
        emptied * 1_000 +
        foundationTotal(next) * 10 +
        revealedTotal(next);
      candidates.push({ state: next, actions, score });
    }
    candidates.sort((a, b) => b.score - a.score);

    for (const candidate of candidates) {
      const deeper = dfs(candidate.state);
      if (deeper) return lead.concat(candidate.actions, deeper);
    }
    return null;
  }

  return dfs(compactFromDeal(deal));
}

// ──────────────────────────────────────────────────────────────────────────
// Witness replay — the engine is the judge
// ──────────────────────────────────────────────────────────────────────────

/** Draw until `card` is on top of the waste. Returns the new state, or null. */
function cycleToWasteTop(
  state: SolitaireState,
  card: Card,
): { state: SolitaireState; draws: number } | null {
  let current = cloneState(state);
  let draws = 0;
  // Two full deck passes is more than enough to surface any single card.
  for (let guard = 0; guard < DECK_SIZE * 4; guard += 1) {
    const wasteTop = current.waste[current.waste.length - 1];
    if (wasteTop && sameCard(wasteTop, card)) return { state: current, draws };

    const applied = applyMove({ state: current, move: { kind: "draw" } });
    if (!applied.ok) return null;
    current = applied.state;
    draws += 1;
  }
  return null;
}

/**
 * Replay a compact witness through the authoritative engine.
 *
 * Pool plays are expanded into the real draws that cycle the wanted card to the
 * waste top, so the result is an ordinary Klondike game. Returns the number of
 * engine moves played when the board finishes, or null if any move is refused
 * or the board does not end solved.
 */
function replayActions(deal: SolitaireDeal, actions: SolveAction[]): number | null {
  let state = initialStateFromDeal(deal);
  let moves = 0;

  const play = (move: SolitaireMove): boolean => {
    const applied = applyMove({ state, move });
    if (!applied.ok) return false;
    state = applied.state;
    moves += 1;
    return true;
  };

  for (const action of actions) {
    if (action.t === "tf") {
      const top = tableauTop(state, action.from);
      if (!top?.faceUp || !top.card) return null;
      if (!play({ kind: "tableau-to-foundation", fromColumn: action.from, card: top.card, suit: top.card.suit })) {
        return null;
      }
    } else if (action.t === "tt") {
      const card = { suit: indexSuit(action.card), rank: indexRank(action.card) } as Card;
      if (!play({ kind: "tableau-to-tableau", fromColumn: action.from, card, toColumn: action.to })) return null;
    } else if (action.t === "pf") {
      const card = { suit: indexSuit(action.card), rank: indexRank(action.card) } as Card;
      const cycled = cycleToWasteTop(state, card);
      if (!cycled) return null;
      state = cycled.state;
      moves += cycled.draws;
      if (!play({ kind: "waste-to-foundation", suit: card.suit })) return null;
    } else {
      const card = { suit: indexSuit(action.card), rank: indexRank(action.card) } as Card;
      const cycled = cycleToWasteTop(state, card);
      if (!cycled) return null;
      state = cycled.state;
      moves += cycled.draws;
      if (!play({ kind: "waste-to-tableau", toColumn: action.to })) return null;
    }
  }

  return isComplete(state) ? moves : null;
}

// ──────────────────────────────────────────────────────────────────────────
// The public deal generator
// ──────────────────────────────────────────────────────────────────────────

/** The search budget a single public `solveDeal` call may spend. */
const SOLVE_NODE_BUDGET = 60_000;

/**
 * Solve a deal with the strong search and verify the witness through the engine.
 *
 * Returns the engine move count when the deal is winnable, or null. This is the
 * public, single-shot form; the generator below shares its own budget across
 * attempts so one call to `solvableDealFromSeed` stays bounded.
 */
export function solveDeal(deal: SolitaireDeal): number | null {
  const counter = { nodes: 0 };
  const actions = search(deal, counter, SOLVE_NODE_BUDGET);
  if (!actions) return null;
  return replayActions(deal, actions);
}

/** True when `deal` has a verified winning line (see `solveDeal`). */
export function isDealSolvable(deal: SolitaireDeal): boolean {
  return solveDeal(deal) !== null;
}

/**
 * A deal that is guaranteed solvable, derived from `seed`, and NOT laid out.
 *
 * Draws a random deal, keeps it only when the search proves a winning line
 * (verified through the engine) AND the naive foundation-only strategy fails,
 * and otherwise draws the next candidate from the same seed stream. Falls back
 * to the v2 construction only if no candidate can be proven, so a match can
 * never be handed an unsolvable board.
 */
export function solvableDealFromSeed(seed: number): SolitaireDeal {
  const rand = mulberry32(seed);
  const counter = { nodes: 0 };
  let proven: SolitaireDeal | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS && counter.nodes < TOTAL_NODE_BUDGET; attempt += 1) {
    const attemptSeed = attempt === 0 ? seed : Math.floor(rand() * 0x1_0000_0000) >>> 0;
    const deal = dealFromSeed(attemptSeed);

    const limit = Math.min(TOTAL_NODE_BUDGET, counter.nodes + ATTEMPT_NODE_BUDGET);
    const actions = search(deal, counter, limit);
    if (!actions) continue;

    // The engine has to accept every move before this deal is trusted.
    if (replayActions(deal, actions) === null) continue;

    // Keep the first proven deal in reserve even if it turns out to be easy.
    if (!proven) proven = deal;

    // The difficulty gate: cards that can be solved without a single tableau
    // decision are "laid out" and are never served.
    if (greedySolveDeal(deal) !== null) continue;

    return deal;
  }

  return proven ?? constructedDealFromSeed(seed);
}

/** Sanity constants other modules and tests read, so no copy can drift. */
export const SOLVABLE_SHAPE = Object.freeze({
  tableauFloor: V2_TABLEAU_FLOOR,
  tableauCards: TABLEAU_CARDS,
  stockCards: STOCK_SIZE,
  deckSize: DECK_SIZE,
});
