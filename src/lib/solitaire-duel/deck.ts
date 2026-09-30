// src/lib/solitaire-duel/deck.ts
//
// The deterministic deck and deal. Pure: no I/O, no clock, no Math.random().
//
// The whole competitive claim of Solitaire Duel rests on this file. Both seats
// race ONE deal, so the deal must be a pure function of a server-chosen seed:
//
//     serverSeed            (crypto, per match — see ./seeds.js)
//       └─ sha256 → uint32  dealSeed
//            └─ mulberry32  a deterministic float stream
//                 └─ Fisher–Yates  the shuffled deck
//                      └─ dealFromSeed  tableau + stock
//
// Any two runtimes that agree on the seed agree on every card position, which
// is what makes a finished match replayable from the seed alone.
//
// The PRNG is the platform's existing one (`src/lib/physics2d/deterministic.ts`
// — Mulberry32, already used by Mini Golf's course generator and the Memory
// Grid), NOT a second implementation: `Math.random()` here would make a deal
// impossible to reproduce, and a per-seat shuffle would break the identity of
// the shared puzzle outright.
//
// CLIENT-SAFE: this module imports only pure helpers, so the client can apply a
// move optimistically with the very same engine the server validates with. The
// seed itself never reaches the client — `./seeds.js` (which imports `crypto`)
// is the server-only seam.

import { mulberry32 } from "../physics2d/deterministic";
import {
  RANKS,
  STOCK_SIZE,
  SUITS,
  TABLEAU_COLUMNS,
  TABLEAU_CARDS,
  VARIANT,
  VARIANT_VERSION,
} from "./constants";
import type { Card, PileCard, SolitaireDeal } from "./types";

/** A stable identity for a card, for equality and map keys. */
export function cardKey(card: Card): string {
  return `${card.suit}-${card.rank}`;
}

/**
 * The canonical, unshuffled deck: 52 unique cards, suit-major, rank-ascending.
 *
 * Built by enumeration rather than written out, so the deck can never be short
 * a card or contain a duplicate — the two failure modes that would make a
 * "shared puzzle" quietly unfair. Tests assert size, uniqueness and per-suit
 * coverage against `DECK_SIZE`.
 */
export function canonicalDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}

/**
 * Seeded Fisher–Yates shuffle.
 *
 * Every position is swapped exactly once, from the end backwards, and the index
 * is drawn with `Math.floor(rand() * (i + 1))`, which is uniform over `0..i`
 * for a stream in `[0, 1)`. Same seed → same order, in every runtime.
 */
export function shuffledDeck(seed: number): Card[] {
  const deck = canonicalDeck();
  const rand = mulberry32(seed);
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const swap = deck[i];
    deck[i] = deck[j];
    deck[j] = swap;
  }
  return deck;
}

/**
 * Deal the match puzzle from a seed.
 *
 * Standard Klondike opening: column `i` (0-based) receives `i + 1` cards, and
 * only the LAST card of each column is face-up. The remaining 24 cards become
 * the stock. Both seats are handed exactly this object, so there is no second
 * deal and no way for the two boards to start differently.
 *
 * The stock is ordered bottom→top: the next card drawn is the LAST element
 * (see `State.stock` in ./types.ts). That convention is fixed here, once, so
 * the stock order is as deterministic as every other position.
 */
export function dealFromSeed(seed: number): SolitaireDeal {
  const deck = shuffledDeck(seed);
  const tableau: PileCard[][] = [];
  let cursor = 0;

  for (let column = 0; column < TABLEAU_COLUMNS; column += 1) {
    const dealt: PileCard[] = [];
    for (let row = 0; row <= column; row += 1) {
      dealt.push({ card: deck[cursor], faceUp: row === column });
      cursor += 1;
    }
    tableau.push(dealt);
  }

  return {
    variant: VARIANT,
    variantVersion: VARIANT_VERSION,
    tableau,
    stock: deck.slice(cursor),
  };
}

/**
 * A compact fingerprint of a deal, for logs and tests.
 *
 * Not a security primitive: it is a convenience for "did the two seats really
 * get the same puzzle?" and for a human glancing at a stored deal. The
 * authoritative commitment is the SHA-256 of the server seed (./seeds.js).
 */
export function dealFingerprint(deal: SolitaireDeal): string {
  const parts: string[] = [];
  for (const column of deal.tableau) {
    parts.push(column.map((pile) => `${pile.faceUp ? "+" : "-"}${cardKey(pile.card)}`).join(","));
  }
  parts.push(`stock:${deal.stock.map(cardKey).join(",")}`);
  return parts.join("|");
}

/** Sanity constants other modules and tests read, so no copy can drift. */
export const DEAL_SHAPE = Object.freeze({
  columns: TABLEAU_COLUMNS,
  tableauCards: TABLEAU_CARDS,
  stockCards: STOCK_SIZE,
});
