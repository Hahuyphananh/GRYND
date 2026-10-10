/**
 * solitaire-duel-solvable.test.mjs
 *
 * THE SOLVABILITY *AND DIFFICULTY* CLAIM, checked rather than asserted.
 *
 * A pure Fisher–Yates shuffle is unsolvable about a fifth of the time, and an
 * unsolvable board in a 1v1 race is a match that can only end on the inactivity
 * forfeit. The version-2 answer constructed every board backwards from the won
 * position — provably solvable, but trivially solved, because the construction
 * put the cards exactly where the foundations wanted them.
 *
 * `VARIANT_VERSION` 3 replaces that with a random deal that is only served when
 * BOTH hold:
 *
 *   1. a deterministic search proves a winning line, and the authoritative
 *      engine (`./rules.ts`) replays every move of it
 *   2. the naive "take any foundation card, otherwise draw" strategy FAILS, so
 *      the cards are never simply laid out for the player
 *
 * This suite is the check on that claim:
 *
 *   * the opening SHAPE is still standard Klondike, so nothing downstream
 *     (the projection, the UI, the shape rules) has to change
 *   * every sampled deal really is solvable, re-verified by the engine
 *   * NO sampled deal is solvable by the naive strategy (the difficulty gate)
 *   * the retained v2 construction IS solvable by it — proving the gate bites
 *   * the generator is still a PURE FUNCTION of the seed
 *
 * Run:  npm run test:solitaire-duel-solvable
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DECK_SIZE,
  STOCK_SIZE,
  TABLEAU_CARDS,
  TABLEAU_COLUMNS,
  VARIANT,
  VARIANT_VERSION,
} from "../src/lib/solitaire-duel/constants.ts";
import { dealFingerprint } from "../src/lib/solitaire-duel/deck.ts";
import {
  SOLVABLE_SHAPE,
  constructedDealFromSeed,
  greedySolveDeal,
  isDealSolvable,
  solvableDealFromSeed,
  solveDeal,
  stateSolvableVerdict,
} from "../src/lib/solitaire-duel/solvable.ts";
import { initialStateFromDeal } from "../src/lib/solitaire-duel/rules.ts";
import { legalMoves } from "../src/lib/solitaire-duel/ai.ts";

/**
 * The sampled deal seeds, spread across the 32-bit space rather than counting
 * up, so the search and the shuffle run on unrelated streams.
 */
const SEEDS = Array.from({ length: 48 }, (_, index) => (index * 2654435761) % 0xffffffff);

/**
 * The served deals, computed ONCE for the whole file.
 *
 * Each `solvableDealFromSeed` call runs a bounded search, so sampling it per
 * test would multiply that cost several times over. Building the sample at
 * module load keeps the suite fast while still exercising the real generator.
 */
const DEALS = SEEDS.map((seed) => solvableDealFromSeed(seed));

test("v3 is the served variant version", () => {
  assert.equal(VARIANT_VERSION, 3, "the verified, hard generator is version 3");
});

test("the served deal keeps the standard Klondike opening shape", () => {
  DEALS.forEach((deal, index) => {
    const seed = SEEDS[index];

    assert.equal(deal.variant, VARIANT);
    assert.equal(deal.variantVersion, VARIANT_VERSION);

    // Column `i` gets `i + 1` cards — the shape every shape rule expects.
    assert.equal(deal.tableau.length, TABLEAU_COLUMNS);
    assert.deepEqual(
      deal.tableau.map((column) => column.length),
      [1, 2, 3, 4, 5, 6, 7],
      `seed ${seed} produced a non-standard shape`,
    );

    // Exactly one face-up card per column: the last one.
    for (const column of deal.tableau) {
      assert.deepEqual(
        column.map((pile) => pile.faceUp),
        column.map((_, row) => row === column.length - 1),
      );
      for (const pile of column) assert.ok(pile.card, "every tableau position has a card");
    }

    assert.equal(deal.stock.length, STOCK_SIZE);

    // A full deck with no duplicates, split 28 / 24.
    const keys = [
      ...deal.tableau.flat().map((pile) => `${pile.card.suit}-${pile.card.rank}`),
      ...deal.stock.map((card) => `${card.suit}-${card.rank}`),
    ];
    assert.equal(keys.length, DECK_SIZE);
    assert.equal(new Set(keys).size, DECK_SIZE, `seed ${seed} dealt a duplicate card`);
    assert.equal(deal.tableau.flat().length, TABLEAU_CARDS);
  });
});

test("every served deal is solvable, re-verified through the engine", () => {
  DEALS.forEach((deal, index) => {
    const seed = SEEDS[index];
    const moves = solveDeal(deal);
    assert.notEqual(moves, null, `seed ${seed} served an unsolvable deal`);
    assert.ok(moves > 0, `seed ${seed} reported a non-positive move count`);
    assert.equal(isDealSolvable(deal), true);
  });
});

test("no served deal is laid out — the naive strategy cannot solve it", () => {
  DEALS.forEach((deal, index) => {
    const seed = SEEDS[index];
    assert.equal(
      greedySolveDeal(deal),
      null,
      `seed ${seed} is solvable by drawing and placing alone — the cards are laid out`,
    );
  });
});

test("the retained v2 construction IS laid out, proving the gate bites", () => {
  // The exact board the gate exists to reject: solvable, but with no decision
  // to make. If this ever stops being greedy-solvable, the difficulty gate has
  // lost its teeth and should be revisited.
  for (const seed of SEEDS.slice(0, 12)) {
    const constructed = constructedDealFromSeed(seed);
    assert.notEqual(
      greedySolveDeal(constructed),
      null,
      `the v2 construction for seed ${seed} should be solvable without tableau moves`,
    );
    // ...and it is still genuinely solvable, just not hard.
    assert.equal(isDealSolvable(constructed), true);
  }
});

test("a served deal never regresses to the v2 construction", () => {
  for (let index = 0; index < 12; index += 1) {
    const seed = SEEDS[index];
    const served = DEALS[index];
    if (dealFingerprint(served) === dealFingerprint(constructedDealFromSeed(seed))) {
      assert.fail(`seed ${seed} was served the laid-out v2 construction`);
    }
  }
});

test("the deal is still a pure function of the seed", () => {
  for (const seed of SEEDS.slice(0, 6)) {
    assert.equal(
      dealFingerprint(solvableDealFromSeed(seed)),
      dealFingerprint(solvableDealFromSeed(seed)),
      "the same seed must always produce the same deal",
    );
  }

  // Distinct seeds, distinct puzzles.
  const fingerprints = new Set(DEALS.map(dealFingerprint));
  assert.equal(fingerprints.size, DEALS.length, "two sampled seeds share a deal");

  // The generator never consumes ambient entropy: a deal built once is
  // byte-identical to a deal built after an unrelated call.
  const before = dealFingerprint(solvableDealFromSeed(SEEDS[2]));
  solvableDealFromSeed(SEEDS[5]);
  assert.equal(dealFingerprint(solvableDealFromSeed(SEEDS[2])), before);
});

/**
 * A VALID board one move from won: 51 cards on the foundations with K♣ alone on
 * tableau column 0. Every card appears exactly once, so it is a legal position.
 */
function oneMoveFromWon() {
  const state = initialStateFromDeal(solvableDealFromSeed(SEEDS[0]));
  state.tableau = Array.from({ length: TABLEAU_COLUMNS }, () => []);
  state.tableau[0] = [{ card: { suit: "clubs", rank: 13 }, faceUp: true }];
  state.stock = [];
  state.waste = [];
  state.foundations = {
    spades: Array.from({ length: 13 }, (_, i) => ({ suit: "spades", rank: i + 1 })),
    hearts: Array.from({ length: 13 }, (_, i) => ({ suit: "hearts", rank: i + 1 })),
    diamonds: Array.from({ length: 13 }, (_, i) => ({ suit: "diamonds", rank: i + 1 })),
    clubs: Array.from({ length: 12 }, (_, i) => ({ suit: "clubs", rank: i + 1 })),
  };
  state.ply = 40;
  state.peakFoundation = 51;
  return state;
}

/** A board with no legal move at all: seven columns topped by black fives. */
function deadBoard() {
  const state = initialStateFromDeal(solvableDealFromSeed(SEEDS[0]));
  state.tableau = Array.from({ length: TABLEAU_COLUMNS }, () => [
    { card: { suit: "spades", rank: 5 }, faceUp: true },
  ]);
  state.stock = [];
  state.waste = [];
  state.foundations = { spades: [], hearts: [], diamonds: [], clubs: [] };
  return state;
}

// ── Live-position solvability (the re-deal trigger) ───────────────────────

test("state check: a served deal's opening is never called impossible", () => {
  for (const seed of SEEDS.slice(0, 6)) {
    const state = initialStateFromDeal(solvableDealFromSeed(seed));
    assert.notEqual(
      stateSolvableVerdict(state),
      "impossible",
      `seed ${seed}: a served deal's opening must never be reported impossible`,
    );
  }
});

test("state check: a board with no legal move left is impossible", () => {
  assert.equal(stateSolvableVerdict(deadBoard()), "impossible");
});

test("state check: one move from won is solvable", () => {
  assert.equal(stateSolvableVerdict(oneMoveFromWon()), "solvable");
});

test("state check: a position the player can still move on is never impossible", () => {
  // THE RE-DEAL GATE's soundness, on a board with exactly ONE legal move: seven
  // columns topped by black kings (no empty column can receive one, nothing can
  // be placed) and a single card left in the stock, so the only move is the
  // draw. The re-deal must be tied to "no move at all": a player with even one
  // move plays on. This is the class of board the older trigger re-dealt — its
  // compact search plays every foundation card the moment it fits and never
  // models pulling one back down, so it concluded "impossible" on winnable
  // boards and restarted them mid-game.
  const state = initialStateFromDeal(solvableDealFromSeed(SEEDS[0]));
  state.tableau = Array.from({ length: TABLEAU_COLUMNS }, () => [
    { card: { suit: "spades", rank: 13 }, faceUp: true },
  ]);
  state.stock = [{ suit: "clubs", rank: 9 }];
  state.waste = [];
  state.foundations = { spades: [], hearts: [], diamonds: [], clubs: [] };

  const moves = legalMoves(state);
  assert.equal(moves.length, 1, `the fixture must offer exactly one move, saw ${moves.length}`);
  assert.equal(moves[0].kind, "draw");
  assert.notEqual(
    stateSolvableVerdict(state),
    "impossible",
    "a board with a move left must never be reported as a loss",
  );

  // ...and the dead fixture really is the no-move case the gate keys on.
  assert.equal(legalMoves(deadBoard()).length, 0, "the dead fixture must have no move");
  assert.equal(stateSolvableVerdict(deadBoard()), "impossible");
});

test("state check: a blown budget is UNKNOWN, never impossible", () => {
  // A King on top of a buried deuce, with six empty columns: the King can move
  // onto an empty column, so a one-node budget cannot exhaust the search — and
  // an inconclusive search must never be reported as a loss.
  const state = initialStateFromDeal(solvableDealFromSeed(SEEDS[0]));
  state.tableau = Array.from({ length: TABLEAU_COLUMNS }, () => []);
  state.tableau[0] = [
    { card: { suit: "clubs", rank: 2 }, faceUp: true },
    { card: { suit: "spades", rank: 13 }, faceUp: true },
  ];
  state.stock = [];
  state.waste = [];
  state.foundations = { spades: [], hearts: [], diamonds: [], clubs: [] };
  assert.equal(stateSolvableVerdict(state, 1), "unknown");
});

test("the exported shape constants match the game's own constants", () => {
  assert.deepEqual(SOLVABLE_SHAPE, {
    tableauFloor: 7,
    tableauCards: TABLEAU_CARDS,
    stockCards: STOCK_SIZE,
    deckSize: DECK_SIZE,
  });
});
