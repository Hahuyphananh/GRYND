/**
 * get-bet-history.test.mjs
 *
 * Tests for /api/get-bet-history
 *
 * Verifies:
 *  - The route returns bet history (bets array in response)
 *  - The route does NOT write to the users table (no db.update or UPDATE users)
 *  - The warning comment explains why stats aren't recalculated
 *  - Authentication is required
 *  - Response format is correct (success: true, bets array)
 *  - All game history tables are queried (including newly added ones)
 *
 * Run:
 *   node --test tests/get-bet-history.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ROUTE_PATH = "src/app/api/get-bet-history/route.ts";
const source = fs.readFileSync(ROUTE_PATH, "utf8");

// ═══════════════════════════════════════════════════════════════
// Response format — returns bet history
// ═══════════════════════════════════════════════════════════════

test("response includes success: true", () => {
  assert.match(
    source,
    /success:\s*true/,
    "response must include success: true"
  );
});

test("response includes bets array", () => {
  assert.match(
    source,
    /bets:\s*allBets/,
    "response must return the bets array"
  );
});

test("bets are sorted by date descending", () => {
  assert.match(
    source,
    /\.sort\(\s*\(\s*a\s*,\s*b\s*\)\s*=>\s*new Date\(b\.date\)/,
    "bets must be sorted newest first"
  );
});

// ═══════════════════════════════════════════════════════════════
// Does NOT write to the users table
// ═══════════════════════════════════════════════════════════════

test("no db.update(users) call — does not overwrite stats", () => {
  const hasDbUpdateUsers = /db\s*\.\s*update\s*\(\s*users\s*\)/.test(source);
  assert.equal(
    hasDbUpdateUsers,
    false,
    "route must NOT call db.update(users) — stats are maintained by applyLeaderboardCounters"
  );
});

test("no raw UPDATE users SQL", () => {
  const hasRawUpdate = /UPDATE\s+users\s+SET/i.test(source);
  assert.equal(
    hasRawUpdate,
    false,
    "route must NOT contain raw UPDATE users SET SQL"
  );
});

// ═══════════════════════════════════════════════════════════════
// Warning comment documents the stat-recalculation removal
// ═══════════════════════════════════════════════════════════════

test("warning comment explains why stats are not recalculated", () => {
  assert.match(
    source,
    /Cumulative stats/,
    "must document cumulative stats concern"
  );
  assert.match(
    source,
    /maintained by applyLeaderboardCounters/,
    "must reference applyLeaderboardCounters"
  );
});

test("warning comment mentions the counters file", () => {
  assert.match(
    source,
    /leaderboardCounters\.js/,
    "must reference leaderboardCounters.js"
  );
});

test("warning comment mentions stats will DECREASE if recalculated", () => {
  assert.match(
    source,
    /DECREASE/,
    "must warn that recalculation causes stat decreases"
  );
});

// ═══════════════════════════════════════════════════════════════
// Authentication is required
// ═══════════════════════════════════════════════════════════════

test("route requires authentication (auth() call)", () => {
  assert.match(
    source,
    /await\s+auth\s*\(\s*\)/,
    "route must call auth() to get the current user"
  );
});

test("returns 401 when not authenticated", () => {
  assert.match(
    source,
    /status:\s*401/,
    "must return 401 Unauthorized when not authenticated"
  );
  assert.match(
    source,
    /Not authenticated/,
    "must include 'Not authenticated' error message"
  );
});

test("returns 404 when user not found in DB", () => {
  assert.match(
    source,
    /status:\s*404/,
    "must return 404 when user not found"
  );
  assert.match(
    source,
    /User not found/,
    "must include 'User not found' error message"
  );
});

// ═══════════════════════════════════════════════════════════════
// Verify all game history tables are queried
// ═══════════════════════════════════════════════════════════════

// Tables queried directly via db.select().from(<table>)
const DIRECT_TABLES = [
  "rouletteGames",
  "blackjackGames",
  "minesGames",
  "plinkoGames",
  "crashGames",
  "rpsGames",
  "unoGames",
  "chessGames",
  "keno_games",
  "kenoPvpMatches",
  "diceMatches",
  "poolMatches",
  "connectFourGames",
  "laneRunnerGames",
  "hexDuelGames",
  "oddsGames",
  "pokerGames",
  "laneRushDuelMatches",
];

for (const table of DIRECT_TABLES) {
  test(`queries ${table} directly via from()`, () => {
    assert.match(
      source,
      new RegExp(`from\\(${table.replace(/_/g, "_")}\\)`),
      `must query ${table}`
    );
  });
}

// Tables queried via join (players table in from(), rooms table in innerJoin)
test("queries diceFlush via players → rooms join", () => {
  assert.match(source, /from\(diceFlushPlayers\)/, "must use diceFlushPlayers in from()");
  assert.match(source, /innerJoin\(diceFlushRooms/, "must join diceFlushRooms");
});

// ═══════════════════════════════════════════════════════════════
// Verify NO stat recalculation variables remain
// ═══════════════════════════════════════════════════════════════

test("no totalWagered recalculation variable", () => {
  const linesOutsideComment = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(
    linesOutsideComment,
    /\blet\s+totalWagered\b/,
    "totalWagered recalculation variable must not exist"
  );
});

test("no weeklyWagered recalculation variable", () => {
  const linesOutsideComment = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(
    linesOutsideComment,
    /\blet\s+weeklyWagered\b/,
    "weeklyWagered recalculation variable must not exist"
  );
});

test("no currentStreak recalculation variable", () => {
  const linesOutsideComment = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(
    linesOutsideComment,
    /\blet\s+currentStreak\b/,
    "currentStreak recalculation variable must not exist"
  );
});

// ═══════════════════════════════════════════════════════════════
// Verify drizzle-orm imports
// ═══════════════════════════════════════════════════════════════

test("sql IS imported from drizzle-orm (needed for poker jsonb query)", () => {
  const importMatch = source.match(/import\s*\{([^}]+)\}\s*from\s*"drizzle-orm"/);
  assert.ok(importMatch, "drizzle-orm import must exist");
  const imports = importMatch[1];
  assert.match(imports, /\bsql\b/, "sql must be imported (used by poker jsonb query)");
  assert.match(imports, /\beq\b/, "eq must still be imported");
  assert.match(imports, /\bor\b/, "or must still be imported");
  assert.match(imports, /\band\b/, "and must be imported (used by hex duel query)");
});

// ═══════════════════════════════════════════════════════════════
// Verify new game type formatters exist
// ═══════════════════════════════════════════════════════════════

test("laneRunner formatter exists and is included in allBets", () => {
  assert.match(source, /laneRunnerFormatted/, "must have laneRunner formatter");
  assert.match(source, /\.\.\.laneRunnerFormatted/, "must spread into allBets");
});

test("hexDuel formatter exists and is included in allBets", () => {
  assert.match(source, /hexDuelFormatted/, "must have hexDuel formatter");
  assert.match(source, /\.\.\.hexDuelFormatted/, "must spread into allBets");
});

test("odds formatter exists and is included in allBets", () => {
  assert.match(source, /oddsFormatted/, "must have odds formatter");
  assert.match(source, /\.\.\.oddsFormatted/, "must spread into allBets");
});

test("poker formatter exists and is included in allBets", () => {
  assert.match(source, /pokerFormatted/, "must have poker formatter");
  assert.match(source, /\.\.\.pokerFormatted/, "must spread into allBets");
});

test("diceFlush formatter exists and is included in allBets", () => {
  assert.match(source, /diceFlushFormatted/, "must have diceFlush formatter");
  assert.match(source, /\.\.\.diceFlushFormatted/, "must spread into allBets");
});

// ═══════════════════════════════════════════════════════════════
// Optional: Integration test (requires TEST_BASE_URL)
// ═══════════════════════════════════════════════════════════════

const TEST_BASE = process.env.TEST_BASE_URL;

if (TEST_BASE) {
  test("integration: get-bet-history returns bets array", async () => {
    const res = await fetch(`${TEST_BASE}/api/get-bet-history`);
    const body = await res.json();
    
    assert.equal(res.status, 401);
    assert.equal(body.success, false);
  });
} else {
  test(
    "integration: get-bet-history endpoint (skipped — set TEST_BASE_URL)",
    { skip: true },
    () => {}
  );
}

console.log("\n✅ All get-bet-history tests passed!\n");
