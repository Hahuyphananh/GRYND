import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

for (const [name, path, gameKey] of [
  ["blackjack", "src/lib/blackjack-pvp/serverStore.js", "blackjack-pvp"],
  ["roulette", "src/lib/roulette-pvp/serverStore.js", "roulette-pvp"],
  ["plinko", "src/lib/plinko-pvp/serverStore.js", "plinko-pvp"],
]) {
  test(`${name} has canonical queue and terminal lifecycle wiring`, () => {
    const source = fs.readFileSync(path, "utf8");
    assert.match(source, /canonicalQueueLifecycle/);
    assert.match(source, new RegExp(`gameKey: "${gameKey}"`));
    assert.match(source, /status: "cancelled"/);
    assert.match(source, /cancelReason: "user_cancelled"|cancelReason: "timeout"/);
  });
}
