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

test("uno ai-turn authorizes the practice seat (guest or account)", () => {
  const file = read("src/app/api/uno/ai-turn/route.js");
  // The free vs-AI practice path is open to signed-out guests, so
  // authorisation runs through the shared practice gate — a Clerk session OR a signed guest
  // id — instead of the account-only age gate. The AI seat is still tied to the
  // game's owner by `isUnoSeat`, so a non-owner still gets a 403.
  assert.match(
    file,
    /requirePracticePlayer/,
    "route should require a practice player (account or guest)",
  );
  assert.match(
    file,
    /users\.clerkId/,
    "route should resolve the signed-in DB user",
  );
  assert.match(file, /isUnoSeat\(/, "route should compare against the game seat");
  assert.match(file, /Forbidden/, "route should reject non-owner access");
});
