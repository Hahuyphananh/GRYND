/**
 * solitaire-duel-deck.test.mjs
 *
 * THE SHARED PUZZLE.
 *
 * Solitaire Duel's entire competitive claim is that both seats race ONE deal.
 * So these tests are about determinism and identity, not about game rules:
 *
 *   1. the same seed produces the same deal — every time, in any runtime
 *   2. both seats' starting states are identical, and independent
 *   3. the opening position is a real Klondike deal (7 columns, 1..7 cards, only
 *      the last of each face-up, 24 in the stock, 52 unique cards once)
 *   4. the deal is reproducible from the match seed alone, and the commitment
 *      hash reveals it honestly after the match
 *
 * Run:  npm run test:solitaire-duel
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalDeck,
  cardKey,
  dealFromSeed,
  dealFingerprint,
  shuffledDeck,
} from "../src/lib/solitaire-duel/deck.ts";
import {
  DECK_SIZE,
  STOCK_SIZE,
  TABLEAU_CARDS,
  TABLEAU_COLUMNS,
  VARIANT,
  VARIANT_VERSION,
} from "../src/lib/solitaire-duel/constants.ts";
import {
  initialStateFromDeal,
  progressOf,
  revealedTableauCount,
} from "../src/lib/solitaire-duel/rules.ts";
import {
  deriveDealSeed,
  getServerSeedHash,
  randomHex,
  verifyDealSeed,
} from "../src/lib/solitaire-duel/seeds.js";

const SEEDS = [0, 1, 2, 42, 12345, 0xffffffff, 0x53505459];

// ── 1. The deck itself ────────────────────────────────────────────────────

test("deck: the canonical deck is 52 unique cards, 13 ranks in each of 4 suits", () => {
  const deck = canonicalDeck();
  assert.equal(deck.length, DECK_SIZE);

  const keys = new Set(deck.map(cardKey));
  assert.equal(keys.size, DECK_SIZE, "every card must be distinct");

  for (const suit of ["spades", "hearts", "diamonds", "clubs"]) {
    const ranks = deck
      .filter((card) => card.suit === suit)
      .map((card) => card.rank)
      .sort((a, b) => a - b);
    assert.deepEqual(ranks, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  }
});

test("deck: the shuffle is a permutation — no card is lost or duplicated", () => {
  for (const seed of SEEDS) {
    const shuffled = shuffledDeck(seed);
    assert.equal(shuffled.length, DECK_SIZE);
    assert.equal(new Set(shuffled.map(cardKey)).size, DECK_SIZE);
    assert.deepEqual(
      [...shuffled.map(cardKey)].sort(),
      [...canonicalDeck().map(cardKey)].sort(),
    );
  }
});

test("deck: identical seeds give an identical order, and different seeds do not", () => {
  for (const seed of SEEDS) {
    assert.deepEqual(shuffledDeck(seed), shuffledDeck(seed));
  }
  // Not a distribution test — just proof the seed is actually used.
  assert.notDeepEqual(shuffledDeck(0), shuffledDeck(1));
});

test("deck: shuffling never mutates the canonical deck", () => {
  const before = canonicalDeck();
  shuffledDeck(7);
  assert.deepEqual(canonicalDeck(), before);
});

// ── 2. Same seed → same deal ──────────────────────────────────────────────

test("deal: the same seed produces the same deal, every time", () => {
  for (const seed of SEEDS) {
    const first = dealFromSeed(seed);
    const second = dealFromSeed(seed);
    assert.deepEqual(first, second);
    assert.equal(dealFingerprint(first), dealFingerprint(second));
  }
});

test("deal: different seeds produce different deals", () => {
  const fingerprints = new Set(SEEDS.map((seed) => dealFingerprint(dealFromSeed(seed))));
  assert.equal(
    fingerprints.size,
    SEEDS.length,
    "distinct seeds collapsed onto the same deal",
  );
});

test("deal: the opening position is a real Klondike deal", () => {
  const deal = dealFromSeed(4242);

  assert.equal(deal.variant, VARIANT);
  assert.equal(deal.variantVersion, VARIANT_VERSION);
  assert.equal(deal.tableau.length, TABLEAU_COLUMNS);

  deal.tableau.forEach((column, index) => {
    assert.equal(column.length, index + 1, `column ${index} must hold ${index + 1} cards`);
    column.forEach((pile, row) => {
      assert.ok(pile.card, "every dealt position holds a card");
      // Only the LAST card of each column is face-up.
      assert.equal(pile.faceUp, row === index, `column ${index} row ${row} face-up flag`);
    });
  });

  const dealt = deal.tableau.flat();
  assert.equal(dealt.length, TABLEAU_CARDS);
  assert.equal(deal.stock.length, STOCK_SIZE);
  assert.equal(dealt.length + deal.stock.length, DECK_SIZE);

  // The 52 cards appear exactly once across the whole deal.
  const keys = [...dealt.map((pile) => cardKey(pile.card)), ...deal.stock.map(cardKey)];
  assert.equal(new Set(keys).size, DECK_SIZE);
});

// ── 3. Both seats get the identical starting state ────────────────────────

test("seats: both seats start from the identical board", () => {
  const deal = dealFromSeed(987654);
  const player1 = initialStateFromDeal(deal);
  const player2 = initialStateFromDeal(deal);

  assert.deepEqual(player1, player2, "the two opening boards must be identical");
  assert.deepEqual(player1.tableau, player2.tableau);
  assert.deepEqual(player1.stock, player2.stock);
  assert.equal(player1.waste.length, 0);
  assert.equal(player2.waste.length, 0);
  for (const suit of ["spades", "hearts", "diamonds", "clubs"]) {
    assert.equal(player1.foundations[suit].length, 0);
    assert.equal(player2.foundations[suit].length, 0);
  }

  // Identical AND independent: touching one seat's position cannot reach the
  // other's (the deal object must not be aliased into the boards). Column 0's
  // only card is face-up by definition, so use a buried one.
  assert.equal(player1.tableau[1][0].faceUp, false);
  player1.tableau[1][0].faceUp = true;
  player1.stock.pop();
  assert.equal(player2.tableau[1][0].faceUp, false, "the other seat must be untouched");
  assert.equal(player2.stock.length, STOCK_SIZE);
  assert.equal(deal.tableau[1][0].faceUp, false, "the deal itself must be untouched");
  assert.equal(deal.stock.length, STOCK_SIZE);
});

test("seats: the opening progress is 0/52 on foundations and 7 revealed", () => {
  const state = initialStateFromDeal(dealFromSeed(31337));
  const progress = progressOf(state);
  assert.equal(progress.foundationCards, 0);
  assert.equal(progress.revealedTableau, 7);
  assert.equal(progress.progressPercent, 0);
  assert.equal(revealedTableauCount(state), 7);
  assert.equal(state.ply, 0);
  assert.equal(state.peakFoundation, 0);
  assert.equal(state.completed, false);
  assert.equal(state.completedAtMs, null);
});

// ── 4. Reproducible from the match seed, and honestly committed ───────────

test("seeds: the deal is reproducible from the server seed alone", () => {
  const serverSeed = randomHex(32);
  assert.match(serverSeed, /^[0-9a-f]{64}$/);

  const first = deriveDealSeed({ serverSeed, variantVersion: VARIANT_VERSION });
  const second = deriveDealSeed({ serverSeed, variantVersion: VARIANT_VERSION });
  assert.equal(first, second, "the derivation must be deterministic");
  assert.ok(Number.isInteger(first) && first >= 0, "must be a positive 32-bit int");

  // A developer holding only the stored server seed can rebuild the exact deal.
  assert.deepEqual(dealFromSeed(first), dealFromSeed(first));
  assert.equal(dealFingerprint(dealFromSeed(first)), dealFingerprint(dealFromSeed(second)));

  // Different seeds → different deal seeds.
  assert.notEqual(first, deriveDealSeed({ serverSeed: randomHex(32) }));
});

test("seeds: the variant version is part of the digest", () => {
  const serverSeed = randomHex(32);
  assert.notEqual(
    deriveDealSeed({ serverSeed, variantVersion: 1 }),
    deriveDealSeed({ serverSeed, variantVersion: 2 }),
    "a ruleset change must derive a different deal",
  );
});

test("seeds: the pre-match commitment hashes to the revealed seed", () => {
  const serverSeed = randomHex(32);
  const commitment = getServerSeedHash(serverSeed);

  assert.match(commitment, /^[0-9a-f]{64}$/);
  assert.equal(commitment, getServerSeedHash(serverSeed));
  assert.notEqual(commitment, getServerSeedHash(randomHex(32)));

  const dealSeed = deriveDealSeed({ serverSeed, variantVersion: VARIANT_VERSION });
  assert.equal(
    verifyDealSeed({ serverSeed, dealSeed, variantVersion: VARIANT_VERSION }),
    true,
  );
  assert.equal(
    verifyDealSeed({ serverSeed: randomHex(32), dealSeed, variantVersion: VARIANT_VERSION }),
    false,
  );
});

test("seeds: randomHex is fresh per call", () => {
  const seeds = new Set([randomHex(32), randomHex(32), randomHex(32)]);
  assert.equal(seeds.size, 3);
});
