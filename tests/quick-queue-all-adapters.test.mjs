import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const worker = fs.readFileSync("src/lib/quickQueueWorker.ts", "utf8");
for (const adapter of [
  "createOrJoinMinesMatch",
  "createOrJoinPlinkoMatch",
  "createOrJoinBlackjackMatch",
  "createOrJoinRouletteMatch",
  "createOrJoinKenoMatch",
  "createOrJoinLaneRushMatch",
  "createOrJoinFourInARowDestination",
]) {
  test(`${adapter} is registered`, () => assert.match(worker, new RegExp(adapter)));
}

test("all supported game keys have adapters", () => {
  for (const game of ["mines-pvp", "plinko-pvp", "blackjack-pvp", "roulette-pvp", "keno-pvp", "lane-rush-duel", "four-in-a-row"]) {
    assert.match(worker, new RegExp(`\\"${game}\\"`));
  }
});
