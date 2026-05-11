import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

test("poker update-hand enforces auth and authorization guard", () => {
  const file = read("src/app/api/poker/update-hand/route.js");
  assert.match(file, /await\s+auth\(\)/, "route should require auth");
  assert.match(
    file,
    /Unauthorized/,
    "route should return Unauthorized on missing auth",
  );
  assert.match(
    file,
    /Forbidden/,
    "route should block unauthorized state mutation",
  );
  assert.match(file, /hostClerkId/, "route should allow host override only");
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
