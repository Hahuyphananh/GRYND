import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_TYPE,
  BLACKJACK_AI_PLAYER_ID,
  PLAYER_STATE,
  RESULT,
  USE_HELD_SUBACTIONS,
  calcHandValue,
  calculateMatchSettlement,
  chooseAiAction,
  isFreeAiMatch,
} from "../src/lib/blackjack-pvp/constants.js";

const card = (value, suit = "♠") => ({ value, suit });

function baseMatch(overrides = {}) {
  return {
    player1Id: "user_123",
    player2Id: BLACKJACK_AI_PLAYER_ID,
    isAi: true,
    stakeAmount: "250.00",
    player2Hand: [card("10"), card("6")],
    player2State: PLAYER_STATE.PLAYING,
    player2UsedSwap: 0,
    player2FrozenCard: null,
    player2HeldResolved: null,
    ...overrides,
  };
}

test("AI stands on a hard 17 or higher", () => {
  const decision = chooseAiAction(baseMatch({
    player2Hand: [card("10"), card("7")],
  }));
  assert.deepEqual(decision, { action: ACTION_TYPE.STAND, payload: {} });
});

test("AI hits below 17", () => {
  const decision = chooseAiAction(baseMatch({
    player2Hand: [card("10"), card("5")],
  }));
  assert.deepEqual(decision, { action: ACTION_TYPE.HIT, payload: {} });
});

test("AI uses a held card with a legal add/discard subaction", () => {
  const add = chooseAiAction(baseMatch({
    player2Hand: [card("10"), card("5")],
    player2FrozenCard: card("4"),
  }));
  assert.equal(add.action, ACTION_TYPE.USE_HELD);
  assert.equal(add.payload.subaction, USE_HELD_SUBACTIONS.ADD);

  const discard = chooseAiAction(baseMatch({
    player2Hand: [card("10"), card("9")],
    player2FrozenCard: card("5"),
  }));
  assert.equal(discard.action, ACTION_TYPE.USE_HELD);
  assert.equal(discard.payload.subaction, USE_HELD_SUBACTIONS.DISCARD);
});

test("AI can recover a busted hand with a valid swap target", () => {
  const decision = chooseAiAction(baseMatch({
    player2Hand: [card("10"), card("K"), card("4")],
    player2State: PLAYER_STATE.BUSTED,
  }));
  assert.equal(decision.action, ACTION_TYPE.SWAP);
  assert.equal(Number.isInteger(decision.payload.swapIndex), true);
  assert.ok(decision.payload.swapIndex >= 0);
  assert.ok(decision.payload.swapIndex < 3);
});

test("AI stands when busted recovery is unavailable", () => {
  const decision = chooseAiAction(baseMatch({
    player2Hand: [card("10"), card("K")],
    player2State: PLAYER_STATE.BUSTED,
    player2UsedSwap: 1,
  }));
  assert.deepEqual(decision, { action: ACTION_TYPE.STAND, payload: {} });
});

test("free AI settlement never pays tokens or fees", () => {
  const match = baseMatch();
  assert.equal(isFreeAiMatch(match), true);
  assert.deepEqual(calculateMatchSettlement(match, RESULT.PLAYER1), {
    winnerId: "user_123",
    fee: 0,
    payout: 0,
    refundEach: 0,
  });
  assert.deepEqual(calculateMatchSettlement(match, RESULT.PLAYER2), {
    winnerId: BLACKJACK_AI_PLAYER_ID,
    fee: 0,
    payout: 0,
    refundEach: 0,
  });
});

test("paid settlement remains separate from free AI settlement", () => {
  const paid = baseMatch({ isAi: false, stakeAmount: "100.00" });
  const settlement = calculateMatchSettlement(paid, RESULT.PLAYER1);
  assert.equal(settlement.winnerId, "user_123");
  assert.equal(settlement.payout, 195);
  assert.equal(settlement.fee, 5);
  assert.equal(calcHandValue([card("A"), card("K")]), 21);
});
