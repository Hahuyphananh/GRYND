import test from "node:test";
import assert from "node:assert/strict";
import {
  BALL_OUTCOME,
  PLINKO_AI_PLAYER_ID,
  RESULT,
  chooseAiLaunchInputs,
  computePayout,
  isFreeAiMatch,
} from "../src/lib/plinko-pvp/constants.js";

test("Plinko AI identity is explicit and cannot be forged by player2Id alone", () => {
  assert.equal(
    isFreeAiMatch({ isAi: true, player2Id: PLINKO_AI_PLAYER_ID }),
    true,
  );
  assert.equal(
    isFreeAiMatch({ isAi: true, player2Id: "real_user" }),
    false,
  );
  assert.equal(
    isFreeAiMatch({ isAi: false, player2Id: PLINKO_AI_PLAYER_ID }),
    false,
  );
});

test("AI launch inputs are deterministic and stay inside human validation ranges", () => {
  const first = chooseAiLaunchInputs({ matchId: 42, ballNumber: 2 });
  const second = chooseAiLaunchInputs({ matchId: 42, ballNumber: 2 });
  assert.deepEqual(first, second);
  assert.ok(first.startX >= 0 && first.startX <= 500);
  assert.ok(first.power >= 0 && first.power <= 100);
  assert.ok(first.angleDeg >= -45 && first.angleDeg <= 45);
  assert.notDeepEqual(first, chooseAiLaunchInputs({ matchId: 42, ballNumber: 3 }));
});

test("free Plinko matches have no token payout even when scores decide a winner", () => {
  const freePayout = computePayout({
    stakeAmount: 0,
    p1Score: 280,
    p2Score: 140,
  });
  assert.equal(freePayout.result, RESULT.PLAYER1);
  assert.equal(freePayout.winnerNet, 0);
  assert.equal(freePayout.houseFee, 0);
  assert.equal(freePayout.prizePaid, 0);
});

test("ball outcome vocabulary remains compatible with persisted Plinko history", () => {
  assert.deepEqual(BALL_OUTCOME, { P1: "p1", P2: "p2", TIE: "tie" });
});
