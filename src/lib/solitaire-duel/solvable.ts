// src/lib/solitaire-duel/solvable.ts
//
// GUARANTEED-SOLVABLE deal generation for Solitaire Duel.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────
//
// A pure Fisher–Yates shuffle produces an unsolvable board roughly a fifth of
// the time. In a 1v1 race that is not a "hard deal" — it is a match that can
// never be finished by solving, so it has to be decided by the inactivity
// forfeit twenty minutes later. That is a bad match for BOTH players, and it is
// the single worst failure mode this game has.
//
// ── THE METHOD: REVERSE WALK FROM THE WON POSITION ──────────────────────
//
// Instead of shuffling and hoping, we construct a deal that we KNOW can be
// solved, by walking the game BACKWARDS from the won position (all 52 cards on
// the foundations) and recording the position we reach.
//
// The construction is exact and needs no search over game states, because the
// inverse of the move we rely on is unconstrained in the right direction:
//
//   * `tableau-to-foundation` is legal whenever the column's TOP card is the
//     rank that foundation expects. It says NOTHING about what sits beneath
//     that card. So in reverse we may drop ANY card onto a column's top as long
//     as the card is one rank lower and the opposite colour — which is exactly
//     the forward tableau-placement rule. (An earlier attempt assumed the
//     reverse move had to respect the foundation's own descending order AND
//     keep the column valid at the same time, which is what made the walk
//     collapse at 27 of 28 cards. It does not have to: the card leaves the
//     foundation's TOP, so the ranks below it are irrelevant.)
//
// So the walk is:
//
//   1. Consume the foundations from King downward. At every rank we may place
//      that rank's card on a column whose top is one rank higher and the other
//      colour, or on an EMPTY column (a "barrier" — the forward
//      `tableau-to-foundation` never checks what is under the card, so a
//      column may legitimately start on any rank).
//   2. Stop when the columns hold exactly 1,2,3,4,5,6,7 cards — the standard
//      Klondike opening shape.
//   3. The cards still on the foundations become the stock, ordered so that a
//      single pass of the deck turns them over in ascending rank order.
//
// ── WHY THE RESULT IS SOLVABLE ──────────────────────────────────────────
//
// Reading the construction forward:
//
//   * The tableau holds ranks 7..13 of every suit; the stock holds ranks 1..6
//     of every suit, ordered 1s, then 2s, … then 6s.
//   * Draw the stock: each card is the rank its foundation expects next, so all
//     24 go straight to the foundations and each suit reaches 6.
//   * Now every tableau card is one rank from its foundation. Because the walk
//     placed ranks in DESCENDING order, the lowest rank in a column is its top
//     — so all the 7s are on top, then all the 8s once the 7s are gone, and so
//     on. Each flips face-up as the card above it leaves, exactly as Klondike
//     promises, and all 28 come off in ascending rank order.
//
// `isDealSolvable` re-derives that forward solve from the finished deal, so the
// claim is checked rather than asserted, and the test suite runs it over a large
// sample of seeds.
//
// ── DETERMINISM ─────────────────────────────────────────────────────────
//
// The walk's choices are drawn from a seeded mulberry32 stream, so the deal is
// a pure function of the match seed — the property the whole fairness claim
// rests on. The search is bounded, and a seed that somehow exhausted the budget
// falls back to the plain shuffle rather than failing the match (a deal that is
// merely not guaranteed-solvable is still a fair, identical deal for both
// seats).

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
import type { Card, PileCard, Rank, SolitaireDeal, SolitaireState, Suit } from "./types";

/** Hearts and diamonds are red. Local so this module does not import ./rules. */
function isRed(suit: Suit): boolean {
  return (RED_SUITS as readonly string[]).includes(suit);
}

/**
 * The lowest rank the tableau may hold.
 *
 * The tableau takes ranks 7..13 of every suit (7 cards × 4 suits = 28) and the
 * stock takes ranks 1..6 (6 × 4 = 24). That split is what lets the stock be
 * drawn in one ascending pass and every tableau card be exactly one rank from
 * its foundation afterwards.
 */
const TABLEAU_FLOOR = 7;

/** A placement during the reverse walk: one card, at one rank, of one suit. */
type Placed = { suit: Suit; rank: Rank };

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
function reverseWalk(rand: () => number): Placed[][] | null {
  // A handful of independent attempts, each with its own random target sizes.
  // An attempt is a bounded backtracking pass; retrying keeps a pathological
  // first target permutation from costing anything.
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
 * Committing to a target size per column (a permutation of 1..7) is what makes
 * this cheap. Total capacity is then exactly 28 — the number of cards — so a
 * pass that never overfills a column finishes with every column at exactly its
 * target, with no repair step. That leaves only the COLOUR rule to satisfy, and
 * the per-rank placement is a small matching problem (four suits onto four
 * distinct columns), which the backtracking below solves directly.
 */
function walkOnce(rand: () => number): Placed[][] | null {
  const columns: Placed[][] = Array.from({ length: TABLEAU_COLUMNS }, () => []);
  // Column `i` will end with `targets[i]` cards: a random permutation of 1..7.
  const targets = shuffleWith(
    Array.from({ length: TABLEAU_COLUMNS }, (_, index) => index + 1),
    rand,
  );
  let nodes = 0;
  // Measured: a successful pass needs at most ~15k nodes, and the first target
  // permutation almost always succeeds. The budget bounds a pathological one so
  // it fails fast and is retried instead of searching the whole space.
  const NODE_BUDGET = 20_000;

  // Descending, so when rank `r` is placed the column's top is always rank
  // `r + 1` — the colour rule below is the forward tableau-placement rule read
  // backwards.
  function placeRank(rank: number): boolean {
    if (rank < TABLEAU_FLOOR) return true;
    if (++nodes > NODE_BUDGET) return false;

    // Each of this rank's four suits goes to a DISTINCT column (a rank has one
    // card per suit, and a column never holds the same rank twice).
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
      // Try the columns with the most room first: filling a wide column keeps
      // the narrow ones available for later ranks, which is where capacity runs
      // out first.
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
  // Every column is exactly at its target (total capacity == total cards), and
  // the targets are a permutation of 1..7 — the standard opening shape.
  return columns;
}

/** The stock, bottom→top, so the next draw is the LAST element. */
function stockForWalk(): Card[] {
  // Draw order: every 1, then every 2, … then every 6 — so a single pass turns
  // each card over as the rank its foundation expects.
  const drawOrder: Card[] = [];
  for (let rank = 1; rank <= TABLEAU_FLOOR - 1; rank += 1) {
    for (const suit of SUITS) drawOrder.push({ suit, rank: rank as Rank });
  }
  // Reversed: the first card drawn is the last element of the stock array.
  return drawOrder.reverse();
}

/**
 * A deal that is guaranteed solvable, derived from `seed`.
 *
 * Falls back to the plain shuffle if the walk cannot reach the opening shape —
 * a bounded search must never fail a match.
 */
export function solvableDealFromSeed(seed: number): SolitaireDeal {
  const rand = mulberry32(seed);
  const walked = reverseWalk(rand);

  if (!walked) {
    // Fallback: the plain shuffle — a fair, identical deal for both seats that
    // is merely not guaranteed solvable. Never expected in practice (the walk
    // succeeded for every seed it has been sampled on), and a bounded search
    // must never fail a match.
    return dealFromSeed(seed);
  }

  // Column order is free (the walk only had to hit the SIZE multiset), so sort
  // by size to produce the canonical column 0 = 1 card … column 6 = 7 cards.
  const ordered = walked.slice().sort((a, b) => a.length - b.length);

  const tableau: PileCard[][] = ordered.map((pile) =>
    pile.map((placed, index) => ({
      card: { suit: placed.suit, rank: placed.rank },
      // Standard Klondike: only the last card of each column is face-up.
      faceUp: index === pile.length - 1,
    })),
  );

  return {
    variant: VARIANT,
    variantVersion: VARIANT_VERSION,
    tableau,
    stock: stockForWalk(),
  };
}

/**
 * The forward solve of a deal, or null if it cannot be solved this way.
 *
 * Deliberately the SIMPLEST strategy that a real player would use — take any
 * card that fits a foundation, otherwise turn the stock over — because it is the
 * claim being verified: the constructed deals are solvable by straightforward
 * play, not only by a search.
 *
 * Returns the number of moves taken, or null if the puzzle stalled.
 */
export function solveDeal(deal: SolitaireDeal): number | null {
  const state: SolitaireState = {
    variant: deal.variant,
    variantVersion: deal.variantVersion,
    tableau: deal.tableau.map((column) =>
      column.map((pile) => ({ card: pile.card, faceUp: pile.faceUp })),
    ),
    stock: deal.stock.map((card) => ({ suit: card.suit, rank: card.rank })),
    waste: [],
    foundations: { spades: [], hearts: [], diamonds: [], clubs: [] },
    ply: 0,
    peakFoundation: 0,
    completed: false,
    completedAtMs: null,
  };

  const foundationCount = () =>
    SUITS.reduce((total, suit) => total + state.foundations[suit].length, 0);
  const expects = (suit: Suit) => state.foundations[suit].length + 1;

  // A generous but finite cap: honest play is well under 500 moves, and a cap
  // is what turns "the greedy strategy loops" into a clean failure.
  const MOVE_LIMIT = 4_000;
  for (let move = 0; move < MOVE_LIMIT; move += 1) {
    if (foundationCount() === DECK_SIZE) return move;

    // 1. The top of any column that fits its foundation.
    let placed = false;
    for (let column = 0; column < state.tableau.length; column += 1) {
      const pile = state.tableau[column];
      const top = pile[pile.length - 1];
      if (!top?.faceUp || !top.card) continue;
      if (top.card.rank !== expects(top.card.suit)) continue;
      pile.pop();
      state.foundations[top.card.suit].push(top.card);
      const below = pile[pile.length - 1];
      if (below && !below.faceUp && below.card) below.faceUp = true;
      placed = true;
      break;
    }
    if (placed) continue;

    // 2. The top of the waste.
    const wasteTop = state.waste[state.waste.length - 1];
    if (wasteTop && wasteTop.rank === expects(wasteTop.suit)) {
      state.waste.pop();
      state.foundations[wasteTop.suit].push(wasteTop);
      continue;
    }

    // 3. Turn a card over (draw, or redeal the waste).
    if (state.stock.length > 0) {
      const card = state.stock.pop();
      if (card) state.waste.push(card);
      continue;
    }
    if (state.waste.length > 0) {
      state.stock = state.waste.slice().reverse();
      state.waste = [];
      continue;
    }

    // Nothing fits and nothing is left to turn over: the deal has stalled.
    return null;
  }
  return null;
}

/** True when `deal` can be solved by straightforward forward play. */
export function isDealSolvable(deal: SolitaireDeal): boolean {
  return solveDeal(deal) !== null;
}

/** Sanity constants other modules and tests read, so no copy can drift. */
export const SOLVABLE_SHAPE = Object.freeze({
  tableauFloor: TABLEAU_FLOOR,
  tableauCards: TABLEAU_CARDS,
  stockCards: STOCK_SIZE,
  deckSize: DECK_SIZE,
});
