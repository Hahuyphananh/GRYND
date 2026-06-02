import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

const hardenedRoutes = [
  "src/app/api/coin-flip/pvp/create/route.js",
  "src/app/api/rps/pvp/create/route.js",
  "src/app/api/dice-duel/create-lobby/route.ts",
  "src/app/api/pool/create-lobby/route.ts",
  "src/app/api/poker/create-game/route.js",
];

test("PvP create routes handle malformed JSON as 400 before DB writes", () => {
  for (const route of hardenedRoutes) {
    const file = read(route);
    assert.match(file, /Invalid JSON payload/, `${route} should reject bad JSON explicitly`);
    assert.match(file, /status:\s*400/, `${route} should return a 400 for validation errors`);
  }
});

test("PvP create routes catch route-level runtime failures", () => {
  for (const route of hardenedRoutes) {
    const file = read(route);
    assert.match(file, /export\s+async\s+function\s+POST[\s\S]*try\s*{/, `${route} should wrap POST logic in try/catch`);
    assert.match(file, /catch\s*\(/, `${route} should catch route-level failures`);
  }
});

test("security middleware accepts configured same-origin deployments and bodyless POSTs", () => {
  const file = read("src/middleware.ts");
  assert.match(file, /NEXT_PUBLIC_APP_URL/, "middleware should allow canonical app origin");
  assert.match(file, /VERCEL_URL/, "middleware should allow Vercel deployment origin");
  assert.match(file, /x-forwarded-host/, "middleware should trust forwarded host behind proxies");
  assert.match(file, /function\s+hasRequestBody/, "middleware should distinguish empty POSTs from JSON body mutations");
  assert.match(file, /X-Content-Type-Options/, "middleware should set nosniff header");
});
