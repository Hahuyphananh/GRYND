import test from "node:test";
import assert from "node:assert/strict";

import {
  BALL_COUNT,
  KENO_POOL_SIZE,
  MAX_ROUNDS,
} from "../src/lib/keno-pvp/constants.js";
import {
  chooseAiCatchPlan,
} from "../src/lib/keno-pvp/engine.js";

test("Keno AI catch plan is deterministic for the same match and round", () => {
  const args = {
    draw: [2, 5, 8, 11, 17, 21, 24, 29, 34, 40],
    roundNumber: 3,
    seed: "match-17",
  };
  assert.deepEqual(chooseAiCatchPlan(args), chooseAiCatchPlan(args));
});

test("Keno AI plan contains only drawn balls with valid reaction delays", () => {
  const draw = [1, 4, 9, 12, 18, 22, 27, 31, 36, 40];
  const plan = chooseAiCatchPlan({ draw, roundNumber: 2, seed: "match-2" });
  assert.ok(plan.length <= BALL_COUNT);
  assert.ok(plan.every((entry) => draw.includes(entry.number)));
  assert.ok(plan.every((entry) => entry.reactionMs >= 150 && entry.reactionMs <= 400));
  assert.equal(new Set(plan.map((entry) => entry.number)).size, plan.length);
});

test("Keno AI plan is bounded and valid across all rounds", () => {
  const draw = Array.from({ length: BALL_COUNT }, (_, i) => i + 1);
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const plan = chooseAiCatchPlan({ draw, roundNumber: round, seed: `m-${round}` });
    assert.ok(plan.every((entry) => entry.number >= 1 && entry.number <= KENO_POOL_SIZE));
    assert.ok(plan.length <= BALL_COUNT);
  }
});
