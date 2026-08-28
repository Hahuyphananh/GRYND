import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const route = fs.readFileSync("src/app/api/keno-pvp/match/[matchId]/route.js", "utf8");
const lookup = fs.readFileSync("src/lib/keno-pvp/canonicalLifecycleLookup.ts", "utf8");

test("Keno match response includes canonical lifecycle data", () => {
  assert.match(route, /getKenoCanonicalLifecycle\(matchId\)/);
  assert.match(route, /canonicalLifecycle,/);
});

test("canonical lifecycle lookup is best effort and does not replace game authority", () => {
  assert.match(lookup, /if \(!row\) return null/);
  assert.match(lookup, /catch \(error\)/);
  assert.match(lookup, /queue_wait_ms/);
});
