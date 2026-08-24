import test from "node:test";
import assert from "node:assert/strict";

import {
  aiSubmissionDelayMs,
  chooseAiReconstruction,
} from "../src/lib/memory-grid/constants.js";

test("Memory Grid AI returns valid, distinct in-range picks", () => {
  const pattern = { size: 4, total: 16, active: [0, 2, 5, 8, 11, 14] };
  const picks = chooseAiReconstruction({ pattern, roundNumber: 3, seed: "match-1" });
  assert.ok(picks.length > 0);
  assert.deepEqual(picks, [...new Set(picks)].sort((a, b) => a - b));
  assert.ok(picks.every((pick) => pick >= 0 && pick < pattern.total));
});

test("Memory Grid AI is deterministic for the same match and round", () => {
  const pattern = { size: 5, total: 25, active: [0, 1, 4, 7, 10, 12, 16, 20, 24] };
  const args = { pattern, roundNumber: 4, seed: "match-42" };
  assert.deepEqual(chooseAiReconstruction(args), chooseAiReconstruction(args));
  assert.equal(
    aiSubmissionDelayMs({ matchId: 42, roundNumber: 4 }),
    aiSubmissionDelayMs({ matchId: 42, roundNumber: 4 }),
  );
});

test("Memory Grid AI gets slower on harder rounds", () => {
  const early = aiSubmissionDelayMs({ matchId: 7, roundNumber: 1 });
  const late = aiSubmissionDelayMs({ matchId: 7, roundNumber: 5 });
  assert.ok(early >= 2500 && early <= 10000);
  assert.ok(late >= 2500 && late <= 10000);
  assert.ok(late > early);
});

test("Memory Grid AI produces a more demanding reconstruction on later rounds", () => {
  const pattern = { size: 5, total: 25, active: Array.from({ length: 14 }, (_, i) => i) };
  const early = chooseAiReconstruction({ pattern, roundNumber: 1, seed: "same" });
  const late = chooseAiReconstruction({ pattern, roundNumber: 5, seed: "same" });
  assert.ok(late.length >= early.length);
});
