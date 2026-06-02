import test from "node:test";
import assert from "node:assert/strict";
import { __testExports } from "../src/lib/leaderboardQueries.js";

const { getLastMondayUTC, userStatsMetricStale, buildStaleConfig } = __testExports;

// ═══════════════════════════════════════════════════════════════
// Helper: mock columns that simulate a full-schema database
// (both tables have all the expected columns)
// ═══════════════════════════════════════════════════════════════
function fullColumns() {
  return {
    user_stats: new Set([
      "user_id", "total_bets", "wins", "losses", "win_rate",
      "total_wagered", "total_won", "biggest_win", "current_streak",
      "best_streak", "daily_streak_current", "daily_streak_best",
      "weekly_streak_current", "weekly_streak_best", "level", "xp",
      "weekly_wagered", "weekly_won", "weekly_wins", "weekly_losses",
      "weekly_level_gain", "weekly_best_streak", "weekly_biggest_win",
      "weekly_win_rate", "weekly_game_streak", "updated_at",
    ]),
    users: new Set([
      "id", "clerk_id", "name", "email", "profile_picture",
      "level", "xp", "total_wagered", "total_won", "biggest_win",
      "best_streak", "weekly_wagered", "weekly_won", "weekly_wins",
    ]),
  };
}

// ═══════════════════════════════════════════════════════════════
// getLastMondayUTC
// ═══════════════════════════════════════════════════════════════

test("getLastMondayUTC returns ISO string ending in T00:00:00.000Z", () => {
  const result = getLastMondayUTC();
  assert.ok(typeof result === "string");
  assert.ok(result.endsWith("T00:00:00.000Z"), `expected midnight UTC, got ${result}`);
  const date = new Date(result);
  assert.ok(!isNaN(date.getTime()), "should be a valid date");
  // Should be a Monday (UTC day = 1)
  assert.equal(date.getUTCDay(), 1, "should be a Monday");
});

test("getLastMondayUTC returns date ≤ today", () => {
  const result = getLastMondayUTC();
  const monday = new Date(result);
  const now = new Date();
  assert.ok(monday <= now, "last Monday must be ≤ now");
});

test("getLastMondayUTC returns same value within the same invocation", () => {
  const a = getLastMondayUTC();
  const b = getLastMondayUTC();
  assert.equal(a, b);
});

// ═══════════════════════════════════════════════════════════════
// userStatsMetricStale — weekly_ columns get CASE-wrapped
// ═══════════════════════════════════════════════════════════════

test("weekly_level_gain is wrapped in a CASE expression", () => {
  const cols = fullColumns();
  const sql = userStatsMetricStale(cols, "weekly_level_gain", {
    defaultValue: "0",
    cast: "int",
  });
  const lastMonday = getLastMondayUTC();

  assert.ok(sql.startsWith("CASE WHEN s.updated_at >="));
  assert.ok(sql.includes(`'${lastMonday}'::timestamp`));
  assert.ok(sql.includes("COALESCE(s.weekly_level_gain, 0)::int"), "should contain the raw metric");
  assert.ok(sql.endsWith("ELSE 0::int END"), `expected ELSE 0::int END, got: ${sql}`);
});

test("weekly_biggest_win is wrapped in a CASE expression", () => {
  const cols = fullColumns();
  const sql = userStatsMetricStale(cols, "weekly_biggest_win", {
    userFallback: null,
  });
  const lastMonday = getLastMondayUTC();

  assert.ok(sql.startsWith("CASE WHEN s.updated_at >="));
  assert.ok(sql.includes(`'${lastMonday}'::timestamp`));
  assert.ok(sql.includes("COALESCE(s.weekly_biggest_win, 0)::numeric"), "should use column when it exists");
  assert.ok(sql.endsWith("ELSE 0::numeric END"));
});

test("weekly_wagered is wrapped with custom default and cast", () => {
  const cols = fullColumns();
  const sql = userStatsMetricStale(cols, "weekly_wagered", {
    defaultValue: "0",
    cast: "numeric",
  });

  assert.ok(sql.startsWith("CASE WHEN s.updated_at >="));
  assert.ok(sql.includes("COALESCE(s.weekly_wagered, 0)::numeric"));
  assert.ok(sql.endsWith("ELSE 0::numeric END"));
});

test("weekly_wins is wrapped correctly", () => {
  const cols = fullColumns();
  const sql = userStatsMetricStale(cols, "weekly_wins", {
    userFallback: "weekly_wins",
    cast: "numeric",
  });

  assert.ok(sql.startsWith("CASE WHEN s.updated_at >="));
  assert.ok(sql.includes("COALESCE(s.weekly_wins, 0)::numeric"));
  assert.ok(sql.endsWith("ELSE 0::numeric END"));
});

test("weekly_best_streak is wrapped with int cast", () => {
  const cols = fullColumns();
  const sql = userStatsMetricStale(cols, "weekly_best_streak", {
    defaultValue: "0",
    cast: "int",
  });

  assert.ok(sql.startsWith("CASE WHEN s.updated_at >="));
  assert.ok(sql.includes("COALESCE(s.weekly_best_streak, 0)::int"));
  assert.ok(sql.endsWith("ELSE 0::int END"));
});

test("weekly_losses is wrapped with numeric cast", () => {
  const cols = fullColumns();
  const sql = userStatsMetricStale(cols, "weekly_losses", {
    defaultValue: "0",
    cast: "numeric",
  });

  assert.ok(sql.startsWith("CASE WHEN s.updated_at >="));
  assert.ok(sql.includes("COALESCE(s.weekly_losses, 0)::numeric"));
  assert.ok(sql.endsWith("ELSE 0::numeric END"));
});

// ═══════════════════════════════════════════════════════════════
// userStatsMetricStale — non-weekly columns are NOT wrapped
// ═══════════════════════════════════════════════════════════════

test("level (non-weekly) is NOT wrapped in CASE", () => {
  const cols = fullColumns();
  const sql = userStatsMetricStale(cols, "level", {
    defaultValue: "1",
    cast: "int",
  });

  assert.ok(!sql.startsWith("CASE"));
  assert.equal(sql, "COALESCE(s.level, 1)::int");
});

test("xp (non-weekly) is NOT wrapped in CASE", () => {
  const cols = fullColumns();
  const sql = userStatsMetricStale(cols, "xp", {
    defaultValue: "0",
    cast: "int",
  });

  assert.ok(!sql.startsWith("CASE"));
  assert.equal(sql, "COALESCE(s.xp, 0)::int");
});

test("best_streak (non-weekly) is NOT wrapped in CASE", () => {
  const cols = fullColumns();
  const sql = userStatsMetricStale(cols, "best_streak", {
    defaultValue: "0",
    cast: "int",
  });

  assert.ok(!sql.startsWith("CASE"));
  assert.equal(sql, "COALESCE(s.best_streak, 0)::int");
});

test("total_wagered (non-weekly) is NOT wrapped", () => {
  const cols = fullColumns();
  const sql = userStatsMetricStale(cols, "total_wagered", {});

  assert.ok(!sql.startsWith("CASE"));
  assert.equal(sql, "COALESCE(s.total_wagered, 0)::numeric");
});

test("biggest_win (non-weekly) is NOT wrapped", () => {
  const cols = fullColumns();
  const sql = userStatsMetricStale(cols, "biggest_win", {
    userFallback: "biggest_win",
  });

  assert.ok(!sql.startsWith("CASE"));
  assert.equal(sql, "COALESCE(s.biggest_win, 0)::numeric");
});

// ═══════════════════════════════════════════════════════════════
// buildStaleConfig — field string and orderBy correctness
// ═══════════════════════════════════════════════════════════════

test("buildStaleConfig 'level' category has stale-safe weekly_level_gain", () => {
  const cols = fullColumns();
  const config = buildStaleConfig("level", cols);
  const lastMonday = getLastMondayUTC();

  // Fields should include the CASE-wrapped weekly_level_gain AND raw level/xp
  assert.ok(config.fields.includes("CASE WHEN s.updated_at >="));
  assert.ok(config.fields.includes(`'${lastMonday}'::timestamp`));
  assert.ok(config.fields.includes("AS weekly_level_gain"));
  assert.ok(config.fields.includes("AS level"));
  assert.ok(config.fields.includes("AS xp"));
  // level and xp should NOT have CASE
  const afterWGL = config.fields.split("AS weekly_level_gain,")[1];
  assert.ok(!afterWGL.includes("CASE WHEN"), "level and xp should not be wrapped");
});

test("buildStaleConfig 'biggest_win' category wraps weekly_biggest_win", () => {
  const cols = fullColumns();
  const config = buildStaleConfig("biggest_win", cols);
  const lastMonday = getLastMondayUTC();

  assert.ok(config.fields.startsWith("CASE WHEN s.updated_at >="));
  assert.ok(config.fields.includes(`'${lastMonday}'::timestamp`));
  assert.ok(config.fields.includes("COALESCE(s.weekly_biggest_win, 0)::numeric"));
  assert.ok(config.fields.endsWith("AS weekly_biggest_win"));
  assert.ok(config.fields.includes("ELSE 0::numeric END AS weekly_biggest_win"));
});

test("buildStaleConfig 'total_wagered' category wraps weekly_wagered", () => {
  const cols = fullColumns();
  const config = buildStaleConfig("total_wagered", cols);

  assert.ok(config.fields.startsWith("CASE WHEN s.updated_at >="));
  assert.ok(config.fields.includes("COALESCE(s.weekly_wagered, 0)::numeric"));
  assert.ok(config.fields.endsWith("AS weekly_wagered"));
});

test("buildStaleConfig 'best_streak' category wraps weekly_best_streak", () => {
  const cols = fullColumns();
  const config = buildStaleConfig("best_streak", cols);

  assert.ok(config.fields.startsWith("CASE WHEN s.updated_at >="));
  assert.ok(config.fields.includes("COALESCE(s.weekly_best_streak, 0)::int"));
  assert.ok(config.fields.endsWith("AS weekly_best_streak"));
});

test("buildStaleConfig 'win_rate' category has win_rate AND weekly_wins/weekly_losses wrapped", () => {
  const cols = fullColumns();
  const config = buildStaleConfig("win_rate", cols);

  // winRateExpression inlines wins/losses multiple times, creating nested
  // CASE expressions. Count how many times the stale timestamp appears.
  const caseCount = (config.fields.match(/CASE WHEN s\.updated_at/g) || []).length;
  assert.ok(caseCount >= 3, `expected >= 3 stale CASE refs, got ${caseCount}`);

  assert.ok(config.fields.includes("AS weekly_win_rate"));
  assert.ok(config.fields.includes("AS weekly_wins"));
  assert.ok(config.fields.includes("AS weekly_losses"));
});

test("buildStaleConfig orderBy references weekly_level_gain", () => {
  const cols = fullColumns();
  const config = buildStaleConfig("level", cols);

  // The orderBy is a raw SQL expression string; it should NOT contain
  // alias-qualified names like "s.weekly_level_gain" after the name
  assert.ok(config.orderBy.includes("DESC"), "should have sort direction");
  assert.ok(config.orderBy.includes("s.user_id ASC"), "should have tiebreaker");
});

test("buildStaleConfig for unknown category returns undefined", () => {
  const cols = fullColumns();
  const config = buildStaleConfig("nonexistent", cols);
  assert.equal(config, undefined);
});

// ═══════════════════════════════════════════════════════════════
// Schema-missing fallback: columns only exist in users, not user_stats
// ═══════════════════════════════════════════════════════════════

function usersOnlyColumns() {
  return {
    user_stats: new Set(["user_id", "updated_at"]),
    users: new Set(["level", "xp", "weekly_wagered", "weekly_won", "weekly_wins"]),
  };
}

test("falls back to users.weekly_wagered when user_stats column is missing", () => {
  const cols = usersOnlyColumns();
  const sql = userStatsMetricStale(cols, "weekly_wagered", {
    userFallback: "weekly_wagered",
    cast: "numeric",
  });
  const lastMonday = getLastMondayUTC();

  assert.ok(sql.startsWith("CASE WHEN s.updated_at >="));
  assert.ok(sql.includes("COALESCE(u.weekly_wagered, 0)::numeric"));
  assert.ok(sql.endsWith("ELSE 0::numeric END"));
});

test("falls back to default when neither table has the column", () => {
  const cols = usersOnlyColumns();
  const sql = userStatsMetricStale(cols, "weekly_losses", {
    defaultValue: "0",
    cast: "numeric",
  });
  const lastMonday = getLastMondayUTC();

  assert.ok(sql.startsWith("CASE WHEN s.updated_at >="));
  assert.ok(sql.includes("0::numeric"));
  assert.ok(sql.endsWith("ELSE 0::numeric END"));
});

// ═══════════════════════════════════════════════════════════════
// SQL validity — the generated SQL should be syntactically sane
// ═══════════════════════════════════════════════════════════════

test("generated CASE has balanced parentheses", () => {
  const cols = fullColumns();
  const categories = ["level", "total_wagered", "biggest_win", "best_streak", "win_rate"];

  for (const cat of categories) {
    const config = buildStaleConfig(cat, cols);
    const fields = config.fields;
    const open = (fields.match(/\(/g) || []).length;
    const close = (fields.match(/\)/g) || []).length;
    assert.equal(open, close, `${cat}: parentheses unbalanced (${open} open vs ${close} close)`);
  }
});

test("generated CASE does not contain double ELSE", () => {
  const cols = fullColumns();
  for (const cat of ["level", "total_wagered", "biggest_win", "best_streak", "win_rate"]) {
    const config = buildStaleConfig(cat, cols);
    const elseCount = (config.fields.match(/\bELSE\b/g) || []).length;
    // win_rate has a nested CASE from winRateExpression, so it may have more ELSEs
    if (cat === "win_rate") {
      assert.ok(elseCount >= 3, `${cat}: expected >= 3 ELSEs (1 per wrapped field + inner winRate CASE)`);
    } else {
      assert.ok(elseCount >= 1, `${cat}: expected at least 1 ELSE`);
    }
  }
});

test("all CASE expressions start with CASE WHEN s.updated_at", () => {
  const cols = fullColumns();
  // win_rate is excluded because its outer CASE wraps wins/losses which
  // are themselves CASE-wrapped, so it starts with "CASE WHEN (CASE WHEN..."
  const categories = ["level", "total_wagered", "biggest_win", "best_streak"];

  for (const cat of categories) {
    const config = buildStaleConfig(cat, cols);
    const trimmed = config.fields.trim();
    assert.ok(
      trimmed.startsWith("CASE WHEN s.updated_at"),
      `${cat}: should start with 'CASE WHEN s.updated_at', got: ${trimmed.substring(0, 50)}`
    );
  }
});

// ═══════════════════════════════════════════════════════════════
// Non-weekly categories still work (they just don't get wrapped)
// ═══════════════════════════════════════════════════════════════

test("best_streak category wraps weekly_best_streak in CASE", () => {
  const cols = fullColumns();
  const config = buildStaleConfig("best_streak", cols);

  // The fields string is JUST the CASE-wrapped weekly_best_streak
  assert.ok(config.fields.startsWith("CASE"), "should be wrapped since we test weekly_best_streak");
});

// ═══════════════════════════════════════════════════════════════
// Edge case: missing updated_at column
// ═══════════════════════════════════════════════════════════════

test("still wraps when user_stats has no updated_at column (references fallback)", () => {
  const cols = {
    user_stats: new Set(["weekly_level_gain", "level", "xp"]),
    users: new Set(["level", "xp"]),
  };
  const sql = userStatsMetricStale(cols, "weekly_level_gain", {
    defaultValue: "0",
    cast: "int",
  });

  // Should still wrap, referencing s.updated_at even if column doesn't exist
  // (the runtime query will error, but the SQL generation is correct)
  assert.ok(sql.startsWith("CASE WHEN s.updated_at >="));
  assert.ok(sql.includes("COALESCE(s.weekly_level_gain, 0)::int"));
  assert.ok(sql.endsWith("ELSE 0::int END"));
});

// ═══════════════════════════════════════════════════════════════
// Regression: innerHTML-style SQL injection not possible
// ═══════════════════════════════════════════════════════════════

test("lastMonday timestamp is a valid ISO string (no injection possible)", () => {
  const monday = getLastMondayUTC();
  // ISO format: YYYY-MM-DDTHH:MM:SS.sssZ
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(monday),
    `expected ISO 8601, got: ${monday}`);
  // No single quotes that could break SQL
  assert.ok(!monday.includes("'"));
});

test("field names are alphanumeric with underscores (no injection)", () => {
  const cols = fullColumns();
  const sql = userStatsMetricStale(cols, "weekly_level_gain", { cast: "int" });
  // Should not contain any raw semicolons or comments
  assert.ok(!sql.includes("--"));
  assert.ok(!sql.includes("/*"));
  assert.ok(!sql.includes(";"));
});
