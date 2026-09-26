import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

test("poker is fully removed: no route, and no client can reach it", () => {
  assert.equal(fs.existsSync("src/app/api/poker"), false);
  assert.equal(fs.existsSync("src/app/casino/poker"), false);
});

test("dice-flush stats enforces auth and participant authorization", () => {
  const file = read("src/app/api/dice-flush/stats/route.js");
  assert.match(file, /requireUser/, "route should require auth");
  assert.match(
    file,
    /Not a participant/,
    "route should reject non-participants from a match detail",
  );
  assert.match(
    file,
    /diceFlushPlayers/,
    "route should verify room participation against diceFlushPlayers",
  );
});

test("uno ai-turn enforces auth and game ownership authorization", () => {
  const file = read("src/app/api/uno/ai-turn/route.js");
  assert.match(file, /await\s+auth\(\)/, "route should require auth");
  assert.match(
    file,
    /users\.clerkId/,
    "route should resolve authenticated DB user",
  );
  assert.match(file, /game\.userId/, "route should compare game owner");
  assert.match(file, /Forbidden/, "route should reject non-owner access");
});
