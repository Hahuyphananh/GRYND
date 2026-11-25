// tests/security-low-priority.test.mjs
//
// Low-severity hardening from the 2026-11 audit (re-derived from the code):
//
//   1. cronAuth kept its own hand-rolled constant-time compare and bearer
//      parser instead of the shared primitives;
//   2. /api/pm/errors returned Postgres message/details/hint/code to the caller;
//   3. /api/security/metrics sat outside the /api/admin MFA gate.
//
// Run with: node --test tests/security-low-priority.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

test("cron auth uses the shared bearer parser and comparison", () => {
  const source = read("src/lib/security/cronAuth.ts");
  assert.match(source, /readBearerToken\(authHeader\)/);
  assert.match(source, /timingSafeEqualString\(providedToken, cronSecret\)/);
  assert.doesNotMatch(
    source,
    /function timingSafeEqual\(/,
    "the hand-rolled compare must be gone",
  );
});

test("the PM error feed does not return Postgres internals", () => {
  const route = read("src/app/api/pm/errors/route.ts");
  assert.doesNotMatch(route, /error:\s*error\.message/);
  assert.doesNotMatch(route, /details:\s*error\.details/);
  assert.doesNotMatch(route, /hint:\s*error\.hint/);
  assert.match(route, /console\.error\("Failed to fetch error logs:", error\)/);
});

test("abuse metrics require an admin with a recent second factor", () => {
  const route = read("src/app/api/security/metrics/route.ts");
  assert.match(route, /isAdmin\(userId\)/);
  assert.match(route, /hasRecentMfa\(factorVerificationAge\)/);
  assert.match(route, /verifyAdminMfaToken/);
  assert.match(route, /MFA required for admin access\./);
  assert.match(route, /Cache-Control": "no-store"/);
});
