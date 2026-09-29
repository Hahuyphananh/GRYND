import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const worker = fs.readFileSync("src/lib/quickQueueWorker.ts", "utf8");
for (const adapter of [
  "createOrJoinMinesMatch",
  "createOrJoinKenoMatch",
  "createOrJoinLaneRushMatch",
  "createOrJoinMiniGolfMatch",
  "createOrJoinSpeedTypingMatch",
  "createOrJoinFourInARowDestination",
  "createOrJoinMemoryGridDestination",
]) {
  test(`${adapter} is registered`, () => assert.match(worker, new RegExp(adapter)));
}

test("all supported game keys have adapters", () => {
  for (const game of ["mines-pvp", "keno-pvp", "lane-rush-duel", "four-in-a-row", "memory-grid", "mini-golf", "speed-typing"]) {
    assert.match(worker, new RegExp(`\\"${game}\\"`));
  }
});
