/**
 * Dice Flush — shared-sheet engine unit tests.
 *
 * The game was redesigned so both players fill ONE shared 12-category
 * scorecard (Chance dropped), each claiming exactly 6 categories by
 * alternating turns. These tests pin the contract:
 *   - shared sheet + ownership tracking
 *   - 6-6 category split and 12-fill game end
 *   - call-the-category bonus
 *   - claim collision rejection
 *   - auto-bank best-category picker
 *   - per-player upper-section bonus (63+) and final totals
 *
 * Run:  node --import tsx --test tests/dice-flush-shared-sheet.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CALL_BONUS,
  TOTAL_CATEGORIES,
  TURN_TIME_LIMIT_MS,
  autoBankIfExpired,
  calculateScore,
  callCategory,
  checkGameEnd,
  matchBreakdown,
  nextTurn,
  pickBestCategory,
  playerCard,
  playerTotals,
  validateMove,
} from "../game-engine/diceFlushEngine";

const ALL_CATEGORIES = [
  "ones", "twos", "threes", "fours", "fives", "sixes",
  "threeOfKind", "fourOfKind", "fullHouse", "smallStraight", "largeStraight", "fiveKind",
];

function makeState(overrides = {}) {
  return {
    id: "t",
    game: "yahtzee",
    players: [
      { userId: "p1", name: "P1" },
      { userId: "p2", name: "P2" },
    ],
    ai: false,
    wager: 100,
    pot: 200,
    state: "playing",
    currentTurn: "p1",
    turnNumber: 1,
    rollsThisTurn: 1,
    dice: [1, 1, 1, 1, 1],
    heldDice: [false, false, false, false, false],
    scorecards: {},
    scorecardOwner: {},
    currentCall: null,
    turnDeadline: Date.now() + TURN_TIME_LIMIT_MS,
    ...overrides,
  };
}

test("two players alternate and each claims exactly 6 of the 12 shared categories", () => {
  let s = makeState();
  const diceSets = {
    p1: [1, 1, 1, 1, 1],
    p2: [2, 2, 2, 2, 2],
  };
  // p1 (starter) fills odd turns, p2 fills even turns
  const turns = [
    ["p1", "ones"], ["p2", "twos"], ["p1", "threes"], ["p2", "fours"],
    ["p1", "fives"], ["p2", "sixes"], ["p1", "threeOfKind"], ["p2", "fourOfKind"],
    ["p1", "fullHouse"], ["p2", "smallStraight"], ["p1", "largeStraight"], ["p2", "fiveKind"],
  ];
  for (const [userId, category] of turns) {
    s.dice = diceSets[userId];
    s.currentTurn = userId;
    s = nextTurn(s, userId, category);
  }

  assert.equal(Object.keys(s.scorecards).length, TOTAL_CATEGORIES, "12 categories filled");
  const p1Card = playerCard(s, "p1");
  const p2Card = playerCard(s, "p2");
  assert.equal(Object.keys(p1Card).length, 6, "p1 owns exactly 6 categories");
  assert.equal(Object.keys(p2Card).length, 6, "p2 owns exactly 6 categories");
  assert.equal(s.scorecardOwner.ones, "p1");
  assert.equal(s.scorecardOwner.twos, "p2");

  const ended = checkGameEnd(s);
  assert.equal(ended.ended, true, "game ends once the shared sheet is full");
});

test("claiming an already-claimed category is rejected (shared sheet)", () => {
  let s = makeState();
  s.dice = [1, 1, 1, 1, 1];
  s = nextTurn(s, "p1", "ones");
  s.currentTurn = "p2";
  s.dice = [2, 2, 2, 2, 2];
  assert.throws(() => nextTurn(s, "p2", "ones"), /Category already used/);
  assert.throws(() => validateMove(s, "p2", "choose_category", { category: "ones" }), /Category already used/);
});

test("call-the-category bonus is applied when the called category is banked", () => {
  let s = makeState();
  s.dice = [5, 5, 5, 5, 5];
  s.currentCall = "fiveKind";
  s = nextTurn(s, "p1", "fiveKind");
  // 50 base (fiveKind) + 15 call bonus
  assert.equal(s.scorecards.fiveKind, 50 + CALL_BONUS);
  assert.equal(s.scorecardOwner.fiveKind, "p1");
  assert.equal(s.currentCall, null, "call resets after the turn");
});

test("call must target an unfilled category and happen before the first roll", () => {
  const s = makeState();
  assert.throws(() => callCategory(s, "ones"), /Call must be made before the first roll/);
  const s2 = makeState({ rollsThisTurn: 0 });
  s2.scorecards = { ones: 5 };
  s2.scorecardOwner = { ones: "p2" };
  assert.throws(() => callCategory(s2, "ones"), /Category already used/);
});

test("pickBestCategory only returns unfilled categories and prefers the best score", () => {
  const s = makeState({
    dice: [1, 2, 3, 4, 6], // large straight is impossible; 3-of-kind impossible
    scorecards: { ones: 5, twos: 5, threes: 5, fours: 5, fives: 5, sixes: 5 },
    scorecardOwner: { ones: "p1", twos: "p2", threes: "p1", fours: "p2", fives: "p1", sixes: "p2" },
  });
  const best = pickBestCategory(s);
  assert.equal(best, "smallStraight", "[1,2,3,4] in dice → 30pt small straight is best open category");
  assert.equal(s.scorecards[best], undefined, "never returns a claimed category");
});

test("auto-bank resolves an expired turn into the best open category with ownership", () => {
  const s = makeState({
    dice: [1, 2, 3, 4, 6],
    turnDeadline: Date.now() - 1, // expired
  });
  const { state, didTimeout } = autoBankIfExpired(s);
  assert.equal(didTimeout, true);
  assert.equal(state.scorecards.smallStraight, 30);
  assert.equal(state.scorecardOwner.smallStraight, "p1");
  assert.equal(state.currentTurn, "p2", "turn advances after auto-bank");
});

test("upper-section bonus (63+) is per player, from their own claimed categories", () => {
  const s = makeState();
  // p1 upper = fours(20) + fives(25) + sixes(30) = 75 ≥ 63 → +35 bonus
  // p2 upper = ones(5) + twos(10) + threes(15) = 30 < 63 → no bonus
  const claims = [
    ["p1", "fours", [4, 4, 4, 4, 4]], // 20 upper
    ["p2", "ones", [1, 1, 1, 1, 1]], // 5 upper
    ["p1", "fives", [5, 5, 5, 5, 5]], // 25 upper
    ["p2", "twos", [2, 2, 2, 2, 2]], // 10 upper
    ["p1", "sixes", [6, 6, 6, 6, 6]], // 30 upper → p1 upper = 75
    ["p2", "threes", [3, 3, 3, 3, 3]], // 15 upper → p2 upper = 30
    ["p1", "threeOfKind", [1, 1, 1, 2, 3]], // 8
    ["p2", "fourOfKind", [2, 2, 2, 2, 3]], // 11
    ["p1", "fullHouse", [3, 3, 3, 5, 5]], // 25
    ["p2", "smallStraight", [1, 2, 3, 4, 6]], // 30
    ["p1", "largeStraight", [1, 2, 3, 4, 5]], // 40
    ["p2", "fiveKind", [6, 6, 6, 6, 6]], // 50
  ];
  let st = s;
  for (const [userId, category, dice] of claims) {
    st.dice = dice;
    st.currentTurn = userId;
    st = nextTurn(st, userId, category);
  }
  const totals = playerTotals(st);
  assert.equal(totals.p1.bonus, 35, "p1 upper (75) ≥ 63 → +35 bonus");
  assert.equal(totals.p2.bonus, 0, "p2 upper (30) < 63 → no bonus");
  // p1 = 20+25+30+8+25+40 + 35 = 183 ; p2 = 5+10+15+11+30+50 = 121
  assert.equal(totals.p1.total, 183);
  assert.equal(totals.p2.total, 121);
  const ended = checkGameEnd(st);
  assert.equal(ended.ended, true);
  assert.equal(ended.winnerId, "p1", "p1's upper-section bonus decides the match");
});

test("matchBreakdown reports per-player categories + totals on the shared sheet", () => {
  let st = makeState();
  const claims = [
    ["p1", "fours", [4, 4, 4, 4, 4]],
    ["p2", "ones", [1, 1, 1, 1, 1]],
    ["p1", "fives", [5, 5, 5, 5, 5]],
    ["p2", "twos", [2, 2, 2, 2, 2]],
    ["p1", "sixes", [6, 6, 6, 6, 6]],
    ["p2", "threes", [3, 3, 3, 3, 3]],
    ["p1", "threeOfKind", [1, 1, 1, 2, 3]],
    ["p2", "fourOfKind", [2, 2, 2, 2, 3]],
    ["p1", "fullHouse", [3, 3, 3, 5, 5]],
    ["p2", "smallStraight", [1, 2, 3, 4, 6]],
    ["p1", "largeStraight", [1, 2, 3, 4, 5]],
    ["p2", "fiveKind", [6, 6, 6, 6, 6]],
  ];
  for (const [userId, category, dice] of claims) {
    st.dice = dice;
    st.currentTurn = userId;
    st = nextTurn(st, userId, category);
  }

  const bd = matchBreakdown(st);
  assert.equal(bd.p1.total, 183, "p1 = 20+25+30+8+25+40 + 35 bonus");
  assert.equal(bd.p2.total, 121, "p2 = 5+10+15+11+30+50, no bonus");
  assert.equal(bd.p1.bonus, 35);
  assert.equal(bd.p2.bonus, 0);
  assert.deepEqual(bd.p1.categories, {
    fours: 20, fives: 25, sixes: 30, threeOfKind: 8, fullHouse: 25, largeStraight: 40,
  });
  assert.equal(Object.keys(bd.p1.categories).length, 6, "each player claims 6 categories");
  assert.equal(Object.keys(bd.p2.categories).length, 6);
});

test("matchBreakdown falls back to legacy per-player scorecards", () => {
  const legacy = makeState({
    scorecards: {
      p1: { ones: 5, twos: 10, threes: 15, threeOfKind: 8, smallStraight: 30, fiveKind: 50 },
      p2: { fours: 20, fives: 25, sixes: 30, fourOfKind: 11, fullHouse: 25, largeStraight: 40 },
    },
    scorecardOwner: {}, // legacy games have no ownership map
  });
  const bd = matchBreakdown(legacy);
  assert.equal(bd.p1.upper, 30);
  assert.equal(bd.p1.bonus, 0, "p1 upper 30 < 63 → no bonus");
  assert.equal(bd.p1.total, 5 + 10 + 15 + 8 + 30 + 50);
  assert.equal(bd.p2.bonus, 35, "p2 upper 75 ≥ 63 → +35");
  assert.equal(bd.p2.total, 20 + 25 + 30 + 11 + 25 + 40 + 35);
});

test("upper-section bonus is awarded once a player's claimed upper categories reach 63", () => {
  const s = makeState();
  const claims = [
    ["p1", "fours", [4, 4, 4, 4, 4]], // 12
    ["p2", "ones", [1, 1, 1, 1, 1]],
    ["p1", "fives", [5, 5, 5, 5, 5]], // 15 → 27
    ["p2", "twos", [2, 2, 2, 2, 2]],
    ["p1", "sixes", [6, 6, 6, 6, 6]], // 18 → 45
    ["p2", "threes", [3, 3, 3, 3, 3]],
    ["p1", "threeOfKind", [6, 6, 6, 6, 6]], // 30 upper? no — threeOfKind is lower
    ["p2", "fourOfKind", [2, 2, 2, 2, 3]],
    ["p1", "fullHouse", [3, 3, 3, 5, 5]],
    ["p2", "smallStraight", [1, 2, 3, 4, 6]],
    ["p1", "largeStraight", [1, 2, 3, 4, 5]],
    ["p2", "fiveKind", [6, 6, 6, 6, 6]],
  ];
  // p1 needs 63 upper from fours+fives+sixes → give p1 ones/twos/threes too? p1 only has 6 turns.
  // Instead: p1 claims all 6 upper categories → upper = 3+6+9+12+15+18 = 63 → bonus!
  const altClaims = [
    ["p1", "ones", [1, 1, 1, 1, 1]], // 5
    ["p2", "threeOfKind", [2, 2, 2, 2, 3]],
    ["p1", "twos", [2, 2, 2, 2, 2]], // 10
    ["p2", "fourOfKind", [2, 2, 2, 2, 3]],
    ["p1", "threes", [3, 3, 3, 3, 3]], // 15
    ["p2", "fullHouse", [3, 3, 3, 5, 5]],
    ["p1", "fours", [4, 4, 4, 4, 4]], // 16
    ["p2", "smallStraight", [1, 2, 3, 4, 6]],
    ["p1", "fives", [5, 5, 5, 5, 5]], // 20
    ["p2", "largeStraight", [1, 2, 3, 4, 5]],
    ["p1", "sixes", [6, 6, 6, 6, 6]], // 30 → upper = 5+10+15+20+25+30 = 105 ≥ 63
    ["p2", "fiveKind", [6, 6, 6, 6, 6]],
  ];
  let st = makeState();
  for (const [userId, category, dice] of altClaims) {
    st.dice = dice;
    st.currentTurn = userId;
    st = nextTurn(st, userId, category);
  }
  const totals = playerTotals(st);
  assert.equal(totals.p1.bonus, 35, "p1 upper 105 ≥ 63 → +35 bonus");
  assert.equal(totals.p1.total, totals.p1.raw + 35);
  // sanity: calculateScore produces the expected upper sums
  assert.equal(calculateScore([1, 1, 1, 1, 1], "ones"), 5);
  assert.equal(calculateScore([6, 6, 6, 6, 6], "sixes"), 30);
});
