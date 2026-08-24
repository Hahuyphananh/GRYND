/**
 * Roulette PvP — skill layer unit tests.
 *
 * Pure-function tests for the elimination-market + opponent-call helpers
 * in `src/lib/roulette-pvp/constants.js`:
 *   1. Server elimination rounds — round 2 kills 13–24, round 3 kills
 *      13–36, round 1 / sudden death keep the full wheel.
 *   2. Spin generation from the LIVE pool — the spin can only land on
 *      numbers that are still on the wheel, and the returned index is
 *      the number's position in the full wheel layout (so the client
 *      animates to the right segment).
 *   3. Biggest-wager detection — including ties (all max keys count).
 *   4. Dead-key detection — single numbers and fully-eliminated groups.
 *   5. Call resolution — both players can win the call in the same round.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  serverEliminatedNumbers,
  generateSpinFromPool,
  biggestWagerKeys,
  isBetKeyLive,
  resolveCalls,
  chooseAiBets,
  calculateMatchSettlement,
  CALL_BONUS,
} from "../src/lib/roulette-pvp/constants.js";
import { ROULETTE_NUMBERS } from "../src/lib/rouletteConfig.js";

const range = (a, b) =>
  Array.from({ length: b - a + 1 }, (_, i) => a + i);

test("serverEliminatedNumbers: round 1 and sudden death keep the full wheel", () => {
  assert.deepEqual(serverEliminatedNumbers(1, false), []);
  assert.deepEqual(serverEliminatedNumbers(4, true), []);
  assert.deepEqual(serverEliminatedNumbers(7, true), []);
});

test("serverEliminatedNumbers: round 2 kills 13–24, round 3 kills 13–36", () => {
  assert.deepEqual(serverEliminatedNumbers(2, false), range(13, 24));
  assert.deepEqual(
    serverEliminatedNumbers(3, false),
    [...range(13, 24), ...range(25, 36)],
  );
  // Sudden-death flag overrides the round number.
  assert.deepEqual(serverEliminatedNumbers(2, true), []);
  assert.deepEqual(serverEliminatedNumbers(3, true), []);
});

test("generateSpinFromPool: result is always inside the live pool", () => {
  const pool = [0, 5, 17, 29];
  for (let i = 0; i < 200; i++) {
    const { spinResult, spinResultIndex } = generateSpinFromPool(pool);
    assert.ok(pool.includes(spinResult), `spin ${spinResult} not in pool`);
    // Index is the position in the FULL wheel layout.
    assert.equal(ROULETTE_NUMBERS[spinResultIndex], spinResult);
  }
  // Degenerate pool guard: empty pool falls back to the full wheel.
  const { spinResult } = generateSpinFromPool([]);
  assert.ok(ROULETTE_NUMBERS.includes(spinResult));
});

test("biggestWagerKeys: empty/zero bets yield no keys", () => {
  assert.deepEqual(biggestWagerKeys(null), []);
  assert.deepEqual(biggestWagerKeys({}), []);
  assert.deepEqual(biggestWagerKeys({ red: 0, black: 0 }), []);
});

test("biggestWagerKeys: single biggest key wins", () => {
  assert.deepEqual(biggestWagerKeys({ red: 5, black: 20, "1-12": 10 }), [
    "black",
  ]);
});

test("biggestWagerKeys: exact ties all count", () => {
  const keys = biggestWagerKeys({ red: 15, black: 15, even: 4 });
  assert.deepEqual(keys.sort(), ["black", "red"]);
});

test("isBetKeyLive: single numbers die with the number", () => {
  const dead = new Set(["17", "0"]);
  assert.equal(isBetKeyLive("17", dead), false);
  assert.equal(isBetKeyLive("18", dead), true);
  assert.equal(isBetKeyLive("0", dead), false);
});

test("isBetKeyLive: a group dies only when every member is dead", () => {
  const dead13to24 = new Set(range(13, 24).map(String));
  assert.equal(isBetKeyLive("13-24", dead13to24), false);
  assert.equal(isBetKeyLive("1-12", dead13to24), true);
  // Red still has live members (1–12 has reds) — stays bettable.
  assert.equal(isBetKeyLive("red", dead13to24), true);
  // Round-3-style full 13–36 kill takes 19-36 down with it.
  const dead13to36 = new Set([...range(13, 36)].map(String));
  assert.equal(isBetKeyLive("19-36", dead13to36), false);
  assert.equal(isBetKeyLive("1-18", dead13to36), true);
  assert.equal(isBetKeyLive("red", dead13to36), true);
});

test("resolveCalls: correct guess transfers CALL_BONUS", () => {
  const result = resolveCalls(
    { player1: "black", player2: null },
    { red: 10, black: 40 },
    { black: 30, even: 5 },
  );
  assert.equal(result.player1.correct, true);
  assert.equal(result.player1.transfer, CALL_BONUS);
  assert.equal(result.player2.correct, false);
});

test("resolveCalls: wrong guess is a miss", () => {
  const result = resolveCalls(
    { player1: "red", player2: "17" },
    { red: 10, black: 40 },
    { black: 30, even: 5 },
  );
  assert.equal(result.player1.correct, false);
  assert.equal(result.player2.correct, false);
});

test("resolveCalls: both players can win the same round", () => {
  const result = resolveCalls(
    { player1: "black", player2: "red" },
    { red: 30, black: 10 },
    { black: 25, even: 5 },
  );
  assert.equal(result.player1.correct, true); // opponent's biggest is black
  assert.equal(result.player2.correct, true); // opponent's biggest is red
  assert.equal(result.player1.transfer, CALL_BONUS);
  assert.equal(result.player2.transfer, CALL_BONUS);
});

test("resolveCalls: ties count as correct for any tied key", () => {
  const result = resolveCalls(
    { player1: "red" },
    {},
    { red: 10, black: 10 },
  );
  assert.equal(result.player1.correct, true);
});

test("resolveCalls: a call against a no-bet opponent always misses", () => {
  const result = resolveCalls({ player1: "red" }, {}, {});
  assert.equal(result.player1.correct, false);
});

test("chooseAiBets: stays within points and avoids eliminated targets", () => {
  const match = {
    player1Bets: { black: 20 },
    playerTwoPoints: 40,
    serverEliminated: [13, 14, 15],
    eliminations: { "17": "player1" },
  };
  const values = [0.01, 0.7, 0.8, 0.2, 0.4, 0.1];
  let index = 0;
  const { bets, call } = chooseAiBets(match, () => values[index++ % values.length]);
  const total = Object.values(bets).reduce((sum, value) => sum + Number(value), 0);
  assert.ok(total > 0);
  assert.ok(total <= 40);
  assert.equal(call, "black");
  assert.equal(bets[13], undefined);
  assert.equal(bets[14], undefined);
  assert.equal(bets[15], undefined);
  assert.equal(bets[17], undefined);
});

test("chooseAiBets: returns an empty legal turn when the bot is out of points", () => {
  assert.deepEqual(
    chooseAiBets({ playerTwoPoints: 0, player1Bets: { red: 10 } }, () => 0.5),
    { bets: {}, call: null },
  );
});

test("calculateMatchSettlement: free AI matches never pay tokens", () => {
  assert.deepEqual(
    calculateMatchSettlement(
      { isAi: true, player1Id: "human", player2Id: "roulette_ai_bot", stakeAmount: 500 },
      "player1",
    ),
    { winnerId: "human", fee: 0, payout: 0 },
  );
});

test("calculateMatchSettlement: paid PvP keeps the existing pot math", () => {
  const settlement = calculateMatchSettlement(
    { isAi: false, player1Id: "human", player2Id: "other", stakeAmount: 100 },
    "player2",
  );
  assert.equal(settlement.winnerId, "other");
  assert.equal(settlement.fee, 5);
  assert.equal(settlement.payout, 195);
});
