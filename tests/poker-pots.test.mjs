// Unit tests for the poker side-pot settlement math
// (src/app/lib/pokerPots.ts).
//
// Run:  node --import tsx --test tests/poker-pots.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { computePayouts, handScore } from "../src/app/lib/pokerPots.ts";

// ── Card / player helpers ──────────────────────────────────────────────

const c = (value, suit) => ({ suit, value });

// A messy community board with no straight, flush, or pair potential
// across the test hands below.
const COMMUNITY = [c("2", "♣"), c("7", "♦"), c("9", "♥"), c("J", "♠"), c("K", "♣")];

function player(id, committed, opts = {}) {
  return {
    id,
    committed,
    hasFolded: Boolean(opts.hasFolded),
    hand: opts.hand ?? [],
  };
}

// A made pair of `value` (score 2).
const pairOf = (value) => [c(value, "♠"), c(value, "♥")];
// A worthless high-card hand (score 1) against COMMUNITY.
const HIGH_CARD = [c("3", "♠"), c("4", "♥")];

const committedTotal = (players) =>
  players.reduce((s, p) => s + (p.committed || 0), 0);
const awardTotal = (payouts) =>
  payouts.reduce((s, w) => s + w.amount, 0);

// ════════════════════════════════════════════════════════════════════════
// handScore
// ════════════════════════════════════════════════════════════════════════

test("handScore: pair beats high card; ladder matches the 1-10 scale", () => {
  assert.equal(handScore(pairOf("A"), COMMUNITY), 2);
  assert.equal(handScore(HIGH_CARD, COMMUNITY), 1);
});

test("handScore: no cards at all scores 0", () => {
  assert.equal(handScore([], []), 0);
});

// ════════════════════════════════════════════════════════════════════════
// computePayouts — fold / single-active
// ════════════════════════════════════════════════════════════════════════

test("single active player (everyone folded) takes the whole pot", () => {
  const players = [
    player("a", 50, { hand: HIGH_CARD }),
    player("b", 100, { hasFolded: true }),
    player("c", 20, { hasFolded: true }),
  ];
  const payouts = computePayouts(players, COMMUNITY);
  assert.deepEqual(payouts, [{ playerId: "a", amount: 170 }]);
});

test("no active players -> no payouts", () => {
  assert.deepEqual(computePayouts([], COMMUNITY), []);
});

// ════════════════════════════════════════════════════════════════════════
// computePayouts — equal contributions
// ════════════════════════════════════════════════════════════════════════

test("equal contributions: best hand wins the whole pot", () => {
  const players = [
    player("a", 100, { hand: HIGH_CARD }),
    player("b", 100, { hand: pairOf("A") }),
  ];
  const payouts = computePayouts(players, COMMUNITY);
  assert.deepEqual(payouts, [{ playerId: "b", amount: 200 }]);
});

test("equal contributions: folded player can't win, chips go to winner", () => {
  const players = [
    player("a", 100, { hand: pairOf("A") }),
    player("b", 100, { hand: HIGH_CARD }),
    player("c", 100, { hasFolded: true }),
  ];
  const payouts = computePayouts(players, COMMUNITY);
  assert.deepEqual(payouts, [{ playerId: "a", amount: 300 }]);
});

// ════════════════════════════════════════════════════════════════════════
// computePayouts — side pots (all-in short stack)
// ════════════════════════════════════════════════════════════════════════

test("short stack all-in with the worse hand loses the main pot to the big stack", () => {
  const players = [
    player("short", 100, { hand: HIGH_CARD }),
    player("big", 500, { hand: pairOf("A") }),
  ];
  const payouts = computePayouts(players, COMMUNITY);
  // Main pot (100x2=200) + side pot (400) all go to the best hand.
  assert.deepEqual(payouts, [{ playerId: "big", amount: 600 }]);
  assert.equal(awardTotal(payouts), committedTotal(players));
});

test("short stack all-in with the best hand wins the main pot, big stack keeps its side pot", () => {
  const players = [
    player("short", 100, { hand: pairOf("A") }),
    player("big", 500, { hand: HIGH_CARD }),
  ];
  const payouts = computePayouts(players, COMMUNITY);
  const byId = Object.fromEntries(payouts.map((w) => [w.playerId, w.amount]));
  // Main pot (200) to short's pair; the 400 side pot comes back to big.
  assert.equal(byId["short"], 200);
  assert.equal(byId["big"], 400);
  assert.equal(awardTotal(payouts), committedTotal(players));
});

test("three-way all-in: each level is contested only by players who contributed enough", () => {
  const players = [
    player("short", 50, { hand: HIGH_CARD }),
    player("mid", 200, { hand: HIGH_CARD }),
    player("big", 500, { hand: pairOf("A") }),
  ];
  const payouts = computePayouts(players, COMMUNITY);
  const byId = Object.fromEntries(payouts.map((w) => [w.playerId, w.amount]));
  // Main pot: 50x3 = 150 → best hand (big, pair A).
  // Level 200: (200-50)x2 = 300 → contenders mid + big → big.
  // Level 500: (500-200)x1 = 300 → big (only contributor).
  assert.equal(byId["big"], 150 + 300 + 300);
  assert.equal(byId["mid"], undefined);
  assert.equal(byId["short"], undefined);
  assert.equal(awardTotal(payouts), committedTotal(players));
});

// ════════════════════════════════════════════════════════════════════════
// computePayouts — folded excess must not vanish
// ════════════════════════════════════════════════════════════════════════

test("leftover chips from a folded player's excess go to the main winner", () => {
  const players = [
    player("folded", 100, { hasFolded: true }),
    player("winner", 50, { hand: pairOf("A") }),
    player("loser", 50, { hand: HIGH_CARD }),
  ];
  const payouts = computePayouts(players, COMMUNITY);
  // Main pot 150 → winner. Folded player's unmatched 50 has no active
  // contender, so it rolls to the main winner — the pot is preserved.
  assert.deepEqual(payouts, [{ playerId: "winner", amount: 200 }]);
  assert.equal(awardTotal(payouts), committedTotal(players));
});

// ════════════════════════════════════════════════════════════════════════
// computePayouts — the pot is always fully distributed
// ════════════════════════════════════════════════════════════════════════

test("payout total always equals total committed across varied scenarios", () => {
  const scenarios = [
    // Two-way all-ins, both orders of hand strength.
    [player("a", 100, { hand: HIGH_CARD }), player("b", 300, { hand: pairOf("A") })],
    [player("a", 100, { hand: pairOf("A") }), player("b", 300, { hand: HIGH_CARD })],
    // Three-way with a folded short stack.
    [
      player("a", 40, { hasFolded: true }),
      player("b", 40, { hand: HIGH_CARD }),
      player("c", 120, { hand: pairOf("A") }),
    ],
    // Everyone checked to showdown with blinds only.
    [
      player("sb", 10, { hand: HIGH_CARD }),
      player("bb", 20, { hand: pairOf("A") }),
      player("utg", 0, { hand: HIGH_CARD }),
    ],
    // All different contribution levels, middle stack best hand.
    [
      player("a", 30, { hand: HIGH_CARD }),
      player("b", 90, { hand: pairOf("A") }),
      player("c", 45, { hand: HIGH_CARD }),
    ],
  ];
  for (const players of scenarios) {
    const payouts = computePayouts(players, COMMUNITY);
    assert.equal(
      awardTotal(payouts),
      committedTotal(players),
      `scenario ${JSON.stringify(players.map((p) => [p.id, p.committed]))} must distribute the full pot`,
    );
    assert.ok(payouts.length >= 1, "every hand produces at least one winner");
    assert.ok(
      payouts.every((w) => w.amount > 0),
      "no zero-amount awards",
    );
  }
});

console.log("\n? All poker pot-settlement tests passed!\n");