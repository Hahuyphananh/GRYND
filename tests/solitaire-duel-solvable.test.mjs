/**
 * solitaire-duel-solvable.test.mjs
 *
 * THE SOLVABILITY CLAIM, checked rather than asserted.
 *
 * A pure Fisher–Yates shuffle is unsolvable about a fifth of the time, and an
 * unsolvable board in a 1v1 race is a match that can only end on the inactivity
 * forfeit. `VARIANT_VERSION` 2 constructs every deal BACKWARDS from the won
 * position instead (`solvableDealFromSeed`), which is meant to make
 * "this deal can be finished" a property of the generator.
 *
 * This suite is the check on that claim:
 *
 *   1. the construction keeps the standard Klondike opening SHAPE, so nothing
 *      downstream (the projection, the UI, the shape rules) has to change
 *   2. every sampled deal really is solvable, verified by a forward solve
 *      rather than trusted
 *   3. the deal is still a PURE FUNCTION of the seed — no entropy, no state
 *   4. the walk, not its fallback, is what produced the sampled deals
 *
 * Run:  node --import tsx --test tests/solitaire-duel-solvable.test.mjs
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
import { dealFingerprint, dealFromSeed } from "../src/lib/solitaire-duel/deck.ts";
import {
  SOLVABLE_SHAPE,
  isDealSolvable,
  solvableDealFromSeed,
  solveDeal,
} from "../src/lib/solitaire-duel/solvable.ts";

/**
 * The sampled deal seeds, spread across the 32-bit space rather than counting
 * up, so the walk is exercised on unrelated streams.
 */
const SEEDS = Array.from({ length: 400 }, (_, index) => (index * 2654435761) % 0xffffffff);

const indexOfSeed = (index) => SEEDS[index % SEEDS.length];

test("the construction keeps the standard Klondike opening shape", () => {
  for (const seed of SEEDS.slice(0, 50)) {
    const deal = solvableDealFromSeed(seed);

    assert.equal(deal.variant, VARIANT);
    assert.equal(deal.variantVersion, VARIANT_VERSION);
    assert.equal(VARIANT_VERSION, 2, "the solvable construction is version 2");

    // Column `i` gets `i + 1` cards — the shape every shape rule expects.
    assert.equal(deal.tableau.length, TABLEAU_COLUMNS);
    assert.deepEqual(
      deal.tableau.map((column) => column.length),
      [1, 2, 3, 4, 5, 6, 7],
    );
    // Exactly one face-up card per column: the last one.
    for (const column of deal.tableau) {
      assert.deepEqual(
        column.map((pile) => pile.faceUp),
        column.map((_, index) => index === column.length - 1),
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
    assert.equal(new Set(keys).size, DECK_SIZE, "no card is dealt twice");
    assert.equal(deal.tableau.flat().length, TABLEAU_CARDS);
  }
});

test("every constructed deal is solvable by straightforward forward play", () => {
  for (const seed of SEEDS) {
    const deal = solvableDealFromSeed(seed);
    const moves = solveDeal(deal);
    assert.notEqual(moves, null, `seed ${seed} produced an unsolvable deal`);
    // Honest play on a constructed deal is a short, bounded sequence — well
    // under the solver's 4 000-move cap. A wildly larger number would mean the
    // deal is solvable only in name.
    assert.ok(
      moves < 200,
      `seed ${seed} needed ${moves} moves, which is not straightforward play`,
    );
    assert.equal(isDealSolvable(deal), true);
  }
});

test("the deal is still a pure function of the seed", () => {
  for (const seed of SEEDS.slice(0, 50)) {
    assert.equal(
      dealFingerprint(solvableDealFromSeed(seed)),
      dealFingerprint(solvableDealFromSeed(seed)),
      "the same seed must always produce the same deal",
    );
  }

  // Distinct seeds, distinct puzzles.
  const fingerprints = new Set(SEEDS.slice(0, 200).map((seed) => dealFingerprint(solvableDealFromSeed(seed))));
  assert.equal(fingerprints.size, 200, "no two sampled seeds share a deal");

  // The generator is deterministic in a second sense too: it is a pure
  // function, so it never consumes ambient entropy. A deal built once is
  // byte-identical to a deal built after an unrelated call.
  const before = dealFingerprint(solvableDealFromSeed(indexOfSeed(7)));
  solvableDealFromSeed(indexOfSeed(11));
  assert.equal(dealFingerprint(solvableDealFromSeed(indexOfSeed(7))), before);
});

test("the walked deal is a genuinely different construction from the v1 shuffle", () => {
  // A sanity check that the samples came from the WALK and not from the
  // fallback: the fallback returns exactly `dealFromSeed(seed)`, so an equal
  // fingerprint would mean the walk failed for that seed.
  let fallbacks = 0;
  for (const seed of SEEDS) {
    if (dealFingerprint(solvableDealFromSeed(seed)) === dealFingerprint(dealFromSeed(seed))) {
      fallbacks += 1;
    }
  }
  assert.equal(fallbacks, 0, "the reverse walk must not be falling back on these seeds");

  // And the v1 shuffle is NOT the thing being served any more: the two agree
  // only by the accident above, which never happens.
  assert.notEqual(
    dealFingerprint(solvableDealFromSeed(indexOfSeed(3))),
    dealFingerprint(dealFromSeed(indexOfSeed(3))),
  );
});

test("the exported shape constants match the game's own constants", () => {
  assert.deepEqual(SOLVABLE_SHAPE, {
    tableauFloor: 7,
    tableauCards: TABLEAU_CARDS,
    stockCards: STOCK_SIZE,
    deckSize: DECK_SIZE,
  });
});
