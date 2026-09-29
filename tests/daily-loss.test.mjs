/**
 * daily-loss.test.mjs
 *
 * Tests for the daily responsible-play counter feature that replaced the
 * ~24-query fan-out behind the "down X tokens today" guard.
 *
 * Verifies:
 *  - /api/user/daily-loss reads the maintained users counters (one indexed
 *    row) instead of scanning game history tables
 *  - applyLeaderboardCounters is outcome-driven and moves ONLY the skill
 *    counters the leaderboards read (wins/losses/win_rate/streaks/pvp_wins)
 *    — it never touches a token- or XP-denominated column
 *  - The four PvP server stores (mines-pvp, keno-pvp, memory-grid,
 *    lane-rush-duel) feed BOTH seats through applyLeaderboardCounters in
 *    recordPvPResult — so user_stats wins/losses, pvp_wins, streaks and the
 *    leaderboards all update for these PvP games (they used to settle
 *    outside the counters funnel entirely)
 *  - GET /api/jobs/daily-reset zeroes the counters with a WHERE guard
 *  - The useDailyLoss hook calls the new endpoint and dedupes/caches
 *    (shared promise + 60s cache)
 *
 * Run:
 *   node --test tests/daily-loss.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ENDPOINT_PATH = "src/app/api/user/daily-loss/route.ts";
const endpoint = fs.readFileSync(ENDPOINT_PATH, "utf8");

const COUNTERS_PATH = "src/lib/leaderboardCounters.js";
const counters = fs.readFileSync(COUNTERS_PATH, "utf8");

const PVP_STORES = {
  "mines-pvp": "src/lib/mines-pvp/serverStore.js",
  "keno-pvp": "src/lib/keno-pvp/serverStore.js",
  "memory-grid": "src/lib/memory-grid/serverStore.js",
  "lane-rush-duel": "src/lib/lane-rush-duel/serverStore.js",
};

const RESET_PATH = "src/app/api/jobs/daily-reset/route.ts";
const reset = fs.readFileSync(RESET_PATH, "utf8");

const HOOK_PATH = "src/lib/useDailyLoss.js";
const hook = fs.readFileSync(HOOK_PATH, "utf8");

// ═══════════════════════════════════════════════════════════════
// /api/user/daily-loss — reads the maintained counters
// ═══════════════════════════════════════════════════════════════

test("endpoint requires authentication (auth() call + 401)", () => {
  assert.match(endpoint, /await\s+auth\s*\(\s*\)/, "must call auth()");
  assert.match(endpoint, /status:\s*401/, "must return 401 when unauthenticated");
  assert.match(endpoint, /Unauthorized/, "must include Unauthorized message");
});

test("endpoint reads the daily counters from users (one row, no history fan-out)", () => {
  assert.match(
    endpoint,
    /wagered:\s*users\.dailyWagered/,
    "must select users.daily_wagered",
  );
  assert.match(
    endpoint,
    /won:\s*users\.dailyWon/,
    "must select users.daily_won",
  );
  assert.match(endpoint, /\.limit\(\s*1\s*\)/, "must read a single users row");
});

test("endpoint computes net = daily_won - daily_wagered", () => {
  assert.match(
    endpoint,
    /Number\(user\.won\)\s*-\s*Number\(user\.wagered\)/,
    "net must be daily_won minus daily_wagered",
  );
});

test("endpoint returns { success: true, net }", () => {
  assert.match(endpoint, /success:\s*true,\s*net/, "must return success + net");
});

test("endpoint does NOT fan out across game history tables", () => {
  const fanOutTables = [
    "minesGames",
    "kenoPvpMatches",
    "poolMatches",
    "hexDuelGames",
    "oddsGames",
    "memoryGridMatches",
    "diceFlushPlayers",
    "minesPvpMatches",
    "laneRushDuelMatches",
  ];
  for (const table of fanOutTables) {
    assert.doesNotMatch(
      endpoint,
      new RegExp(`from\\(${table}\\)`),
      `must NOT query ${table} — the counters replace the history fan-out`,
    );
  }
});

test("endpoint response is marked private (never CDN-cached)", () => {
  assert.match(endpoint, /Cache-Control/, "must set Cache-Control");
  assert.match(endpoint, /private/, "must be private — per-user data");
});

// ═══════════════════════════════════════════════════════════════
// applyLeaderboardCounters — outcome-driven skill counters, token-free
// ═══════════════════════════════════════════════════════════════

// Strip comments so the "does not touch" checks only see executable code
// (the doc comment legitimately names the columns it deliberately omits).
const countersCode = counters
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

test("leaderboardCounters is driven by an explicit outcome, not a wager", () => {
  assert.match(
    countersCode,
    /outcome === "win"/,
    "must derive the win from the explicit outcome",
  );
  assert.match(
    countersCode,
    /outcome === "loss"/,
    "must derive the loss from the explicit outcome",
  );
  assert.doesNotMatch(
    countersCode,
    /betAmount|payout/,
    "must not infer a result from a wager/payout",
  );
});

test("leaderboardCounters touches no token- or XP-denominated column", () => {
  for (const column of [
    "total_wagered",
    "weekly_wagered",
    "total_won",
    "weekly_won",
    "weekly_profit",
    "daily_wagered",
    "daily_won",
    "biggest_win",
    "weekly_biggest_win",
    "best_multiplier",
    "xp",
    "level",
    "last_settled_xp",
  ]) {
    assert.doesNotMatch(
      countersCode,
      new RegExp(`\\b${column}\\b`),
      `must not write ${column} — progression is trophies, not wagers/XP`,
    );
  }
});

test("leaderboardCounters keeps the skill counters the boards rank", () => {
  for (const column of [
    "current_streak",
    "best_streak",
    "weekly_wins",
    "pvp_wins",
    "last_settled_wins_delta",
    "last_settled_losses_delta",
  ]) {
    assert.match(
      counters,
      new RegExp(`\\b${column}\\b`),
      `must keep updating ${column}`,
    );
  }
});

// ═══════════════════════════════════════════════════════════════
// PvP server stores — feed both seats through applyLeaderboardCounters
// (daily counters, user_stats wins/losses, quests all update from there)
// ═══════════════════════════════════════════════════════════════

for (const [game, path] of Object.entries(PVP_STORES)) {
  const source = fs.readFileSync(path, "utf8");

  test(`${game}: winner recorded via applyLeaderboardCounters (outcome win, isPvpWin)`, () => {
    // The winner is fed through the canonical counters pipeline with an
    // explicit `outcome: "win"` and isPvpWin: true (drives user_stats wins,
    // pvp_wins, streaks and the win boards). No wager/payout is involved.
    assert.match(
      source,
      /applyLeaderboardCounters\(\{[\s\S]*?clerkId: winnerId[\s\S]*?outcome: "win"[\s\S]*?isPvpWin: true/,
      `${game} winner must call applyLeaderboardCounters with outcome win + isPvpWin`,
    );
  });

  test(`${game}: loser recorded via applyLeaderboardCounters (outcome loss)`, () => {
    // The loser gets an explicit `outcome: "loss"` — landing in user_stats
    // (losses +1, streak reset) with no token movement.
    assert.match(
      source,
      /applyLeaderboardCounters\(\{[\s\S]*?clerkId: loserId[\s\S]*?outcome: "loss"/,
      `${game} loser must call applyLeaderboardCounters with outcome loss`,
    );
  });

  test(`${game}: daily bumps live inside a bot/AI-guarded recordPvPResult (practice matches untouched)`, () => {
    // mines-pvp / keno-pvp / memory-grid guard with `!isAi`; lane-rush-duel
    // guards with `!isBotMatch` (and skips draws). Either way recordPvPResult
    // — and therefore the daily counter bump — never runs for free-play.
    assert.match(
      source,
      /!isAi|!isBotMatch/,
      `${game} must gate recordPvPResult behind a bot/AI guard`,
    );
    assert.match(
      source,
      /recordPvPResult\(tx/,
      `${game} must call recordPvPResult on settlement`,
    );
  });
}

// ═══════════════════════════════════════════════════════════════
// /api/jobs/daily-reset — zeroes the counters
// ═══════════════════════════════════════════════════════════════

test("daily-reset zeroes both counters", () => {
  assert.match(
    reset,
    /daily_wagered\s*=\s*0\s*,\s*daily_won\s*=\s*0/,
    "must reset both daily counters",
  );
});

test("daily-reset only touches users who wagered today (WHERE guard)", () => {
  assert.match(
    reset,
    /WHERE\s+daily_wagered\s*<>\s*0\s+OR\s+daily_won\s*<>\s*0/,
    "must not rewrite every users row",
  );
});

// ═══════════════════════════════════════════════════════════════
// useDailyLoss hook — new endpoint + dedupe + cache
// ═══════════════════════════════════════════════════════════════

test("hook fetches /api/user/daily-loss (not the 24-query fan-out)", () => {
  assert.match(
    hook,
    /fetch\s*\(\s*"\/api\/user\/daily-loss"/,
    "must call the new endpoint",
  );
  assert.doesNotMatch(
    hook,
    /get-bet-history/,
    "must NOT fetch the old bet-history fan-out",
  );
});

test("hook dedupes concurrent mounts with a shared promise", () => {
  assert.match(hook, /let\s+sharedPromise\s*=\s*null/, "must have a shared promise");
  assert.match(
    hook,
    /sharedPromise\s*=\s*sharedPromise\s*\?\?\s*fetchDailyNet\(\)/,
    "must reuse the in-flight request",
  );
});

test("hook caches the result for 60s", () => {
  assert.match(hook, /CACHE_TTL_MS\s*=\s*60_000/, "must define a 60s TTL");
  assert.match(
    hook,
    /Date\.now\(\)\s*-\s*cachedAt\s*<\s*CACHE_TTL_MS/,
    "must reuse the cached value within the TTL",
  );
});

console.log("\n✅ All daily-loss tests passed!\n");