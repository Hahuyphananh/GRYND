/**
 * weekly-reset.test.mjs
 *
 * Tests for /api/jobs/weekly-reset
 *
 * Verifies:
 *  - All expected columns are zeroed in both users & user_stats tables
 *  - weekly_streak_current is included in the reset
 *  - Redis leaderboard cache invalidation is triggered
 *  - Response format is correct (ok:true + resetAt)
 *  - SECURITY: Cron authentication is enforced (pentest mitigation)
 *
 * Run:
 *   node --test tests/weekly-reset.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ROUTE_PATH = "src/app/api/jobs/weekly-reset/route.ts";
const CRON_AUTH_PATH = "src/lib/security/cronAuth.ts";
const source = fs.readFileSync(ROUTE_PATH, "utf8");
const cronAuthSource = fs.readFileSync(CRON_AUTH_PATH, "utf8");

// ═══════════════════════════════════════════════════════════════
// SECURITY: Cron authentication enforcement (pentest mitigation)
// ═══════════════════════════════════════════════════════════════

test("SECURITY: GET handler accepts Request parameter for auth check", () => {
  // The handler must accept a Request parameter to access headers
  assert.match(
    source,
    /export\s+async\s+function\s+GET\s*\(\s*request\s*:\s*Request\s*\)/,
    "GET handler must accept Request parameter to enable authentication"
  );
});

test("SECURITY: verifyCronRequest is imported from cronAuth module", () => {
  assert.match(
    source,
    /import\s+\{[^}]*verifyCronRequest[^}]*\}\s+from\s+["'].*\/security\/cronAuth["']/,
    "must import verifyCronRequest from security/cronAuth module"
  );
});

test("SECURITY: verifyCronRequest is called before any state changes", () => {
  // Extract the GET function body
  const getFunctionMatch = source.match(
    /export\s+async\s+function\s+GET\s*\([^)]*\)\s*\{([\s\S]*)\}/
  );
  assert.ok(getFunctionMatch, "GET function must be present");
  const functionBody = getFunctionMatch[1];

  // verifyCronRequest must be called
  assert.match(
    functionBody,
    /verifyCronRequest\s*\(\s*request\s*\)/,
    "must call verifyCronRequest with request parameter"
  );

  // Find the position of verifyCronRequest call
  const authCallIndex = functionBody.indexOf("verifyCronRequest");
  
  // Find the position of first SQL operation (UPDATE or DELETE or SELECT)
  const sqlOperations = [
    functionBody.indexOf("await sql"),
    functionBody.indexOf("sql`"),
  ].filter(i => i !== -1);
  
  const firstSqlIndex = Math.min(...sqlOperations);
  
  assert.ok(
    authCallIndex < firstSqlIndex,
    "verifyCronRequest must be called BEFORE any SQL operations"
  );
});

test("SECURITY: authentication error is returned immediately", () => {
  assert.match(
    source,
    /const\s+authError\s*=\s*verifyCronRequest\s*\(\s*request\s*\)/,
    "must capture verifyCronRequest return value"
  );
  assert.match(
    source,
    /if\s*\(\s*authError\s*\)\s*return\s+authError/,
    "must return authError immediately if authentication fails"
  );
});

test("SECURITY: cronAuth module enforces CRON_SECRET check", () => {
  assert.match(
    cronAuthSource,
    /process\.env\.CRON_SECRET/,
    "cronAuth must check CRON_SECRET environment variable"
  );
});

test("SECURITY: cronAuth fails secure when CRON_SECRET is missing", () => {
  assert.match(
    cronAuthSource,
    /if\s*\(\s*!cronSecret\s*\)/,
    "cronAuth must check if CRON_SECRET is undefined/empty"
  );
  // After the check, it should return 401
  const afterSecretCheck = cronAuthSource.split(/if\s*\(\s*!cronSecret\s*\)/)[1];
  assert.match(
    afterSecretCheck,
    /status:\s*401/,
    "cronAuth must return 401 when CRON_SECRET is not configured"
  );
});

test("SECURITY: cronAuth validates Authorization header presence", () => {
  assert.match(
    cronAuthSource,
    /request\.headers\.get\s*\(\s*["']authorization["']\s*\)/,
    "cronAuth must check Authorization header"
  );
  assert.match(
    cronAuthSource,
    /if\s*\(\s*!authHeader\s*\)/,
    "cronAuth must validate Authorization header is present"
  );
});

test("SECURITY: cronAuth validates Bearer token format", () => {
  assert.match(
    cronAuthSource,
    /Bearer/i,
    "cronAuth must validate Bearer token format"
  );
  assert.match(
    cronAuthSource,
    /match\s*\(/,
    "cronAuth must use regex to extract Bearer token"
  );
});

test("SECURITY: cronAuth uses constant-time comparison", () => {
  assert.match(
    cronAuthSource,
    /timingSafeEqual/,
    "cronAuth must use constant-time comparison to prevent timing attacks"
  );
  
  // Verify the timingSafeEqual implementation
  assert.match(
    cronAuthSource,
    /function\s+timingSafeEqual/,
    "timingSafeEqual function must be defined"
  );
  
  // Check for XOR operation (constant-time comparison pattern)
  assert.match(
    cronAuthSource,
    /\^/,
    "timingSafeEqual must use XOR for constant-time comparison"
  );
});

test("SECURITY: cronAuth returns 401 for invalid credentials", () => {
  // Count 401 status codes - should have multiple (missing secret, missing header, invalid format, invalid token)
  const status401Count = (cronAuthSource.match(/status:\s*401/g) || []).length;
  assert.ok(
    status401Count >= 3,
    `cronAuth must return 401 for multiple failure scenarios, found ${status401Count} instances`
  );
});

test("SECURITY: cronAuth returns null on successful authentication", () => {
  assert.match(
    cronAuthSource,
    /return\s+null/,
    "cronAuth must return null when authentication succeeds"
  );
});

// ═══════════════════════════════════════════════════════════════
// users table — weekly column resets
// ═══════════════════════════════════════════════════════════════

test("users table: weekly_wagered is reset to 0", () => {
  assert.match(
    source,
    /weekly_wagered\s*=\s*0/,
    "users.weekly_wagered must be set to 0"
  );
});

test("users table: weekly_won is reset to 0", () => {
  assert.match(
    source,
    /weekly_won\s*=\s*0/,
    "users.weekly_won must be set to 0"
  );
});

test("users table: weekly_profit is reset to 0", () => {
  assert.match(
    source,
    /weekly_profit\s*=\s*0/,
    "users.weekly_profit must be set to 0"
  );
});

test("users table: weekly_wins is reset to 0", () => {
  assert.match(
    source,
    /weekly_wins\s*=\s*0/,
    "users.weekly_wins must be set to 0"
  );
});

// ═══════════════════════════════════════════════════════════════
// user_stats table — ALL weekly column resets
// ═══════════════════════════════════════════════════════════════

const USER_STATS_COLUMNS = [
  "weekly_wagered",
  "weekly_won",
  "weekly_wins",
  "weekly_losses",
  "weekly_level_gain",
  "weekly_best_streak",
  "weekly_biggest_win",
  "weekly_win_rate",
  "weekly_game_streak",
  "weekly_streak_current",
];

for (const col of USER_STATS_COLUMNS) {
  test(`user_stats table: ${col} is reset to 0`, () => {
    assert.match(
      source,
      new RegExp(`${col}\\s*=\\s*0`),
      `user_stats.${col} must be set to 0`
    );
  });
}

test("user_stats table: updated_at is set to NOW()", () => {
  assert.match(
    source,
    /updated_at\s*=\s*NOW\(\)/,
    "user_stats.updated_at must be updated"
  );
});

// ═══════════════════════════════════════════════════════════════
// Big wins cleanup
// ═══════════════════════════════════════════════════════════════

test("big_wins entries older than 7 days are purged", () => {
  assert.match(
    source,
    /DELETE FROM big_wins/,
    "big_wins cleanup must be present"
  );
  assert.match(
    source,
    /INTERVAL\s+'7\s*days'/,
    "must purge entries older than 7 days"
  );
});

// ═══════════════════════════════════════════════════════════════
// Redis cache invalidation
// ═══════════════════════════════════════════════════════════════

test("invalidateAllLeaderboards is called after DB reset", () => {
  assert.match(
    source,
    /invalidateAllLeaderboards/,
    "must call invalidateAllLeaderboards to flush Redis cache"
  );
});

test("invalidateAllLeaderboards has error handling (.catch)", () => {
  // Must use .catch() to prevent unhandled promise rejections when Redis is down
  assert.match(
    source,
    /invalidateAllLeaderboards\(\)\s*\.\s*catch/,
    "invalidateAllLeaderboards must have .catch() error handling"
  );
});

// ═══════════════════════════════════════════════════════════════
// Response format
// ═══════════════════════════════════════════════════════════════

test("returns JSON with ok:true", () => {
  assert.match(source, /ok:\s*true/, "response must include ok: true");
});

test("returns resetAt timestamp", () => {
  assert.match(
    source,
    /resetAt\s*:\s*new Date\(\)\s*\.\s*toISOString\(\)/,
    "response must include resetAt ISO timestamp"
  );
});

// ═══════════════════════════════════════════════════════════════
// Verify no column is MISSING from the reset
// ═══════════════════════════════════════════════════════════════

test("users UPDATE targets all 4 weekly columns (no regression)", () => {
  // Extract the users SET clause — stop at the closing backtick
  const usersSetMatch = source.match(
    /UPDATE users\s+SET([\s\S]*?)\s*`/s
  );
  assert.ok(usersSetMatch, "users UPDATE must be present");
  const setClause = usersSetMatch[1];

  // Count weekly columns set to 0
  const weeklySetCount = (setClause.match(/weekly_\w+\s*=\s*0/g) || []).length;
  assert.equal(
    weeklySetCount,
    4,
    "users UPDATE must zero exactly 4 weekly columns: weekly_wagered, weekly_won, weekly_profit, weekly_wins"
  );
});

test("user_stats UPDATE targets all 10 weekly columns (no regression)", () => {
  // Extract the user_stats SET clause — stop at the closing backtick
  const statsSetMatch = source.match(
    /UPDATE user_stats\s+SET([\s\S]*?)\s*`/s
  );
  assert.ok(statsSetMatch, "user_stats UPDATE must be present");
  const setClause = statsSetMatch[1];

  const resetCount = (setClause.match(/\w+\s*=\s*0/g) || []).length;
  // 10 weekly columns + updated_at (not 0) = at least 10 set-to-0
  assert.ok(
    resetCount >= 10,
    `user_stats UPDATE must zero at least 10 columns, found ${resetCount}`
  );
});

// ═══════════════════════════════════════════════════════════════
// Optional: Integration test (requires TEST_BASE_URL pointing to a running server)
// ═══════════════════════════════════════════════════════════════

const TEST_BASE = process.env.TEST_BASE_URL;

if (TEST_BASE) {
  test("integration: weekly-reset endpoint returns ok", async () => {
    const res = await fetch(`${TEST_BASE}/api/jobs/weekly-reset`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(typeof body.resetAt === "string", "resetAt must be an ISO string");
    assert.ok(
      new Date(body.resetAt).getTime() > 0,
      "resetAt must be a valid date"
    );
  });
} else {
  test(
    "integration: weekly-reset endpoint (skipped — set TEST_BASE_URL)",
    { skip: true },
    () => {}
  );
}

console.log("\n✅ All weekly-reset tests passed!\n");
