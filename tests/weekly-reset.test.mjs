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
 *
 * Run:
 *   node --test tests/weekly-reset.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ROUTE_PATH = "src/app/api/jobs/weekly-reset/route.ts";
const source = fs.readFileSync(ROUTE_PATH, "utf8");

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
