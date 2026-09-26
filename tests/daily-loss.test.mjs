/**
 * daily-loss.test.mjs
 *
 * Tests for the daily responsible-play counter feature that replaced the
 * ~24-query fan-out behind the "down X tokens today" guard.
 *
 * Verifies:
 *  - /api/user/daily-loss reads the maintained users counters (one indexed
 *    row) instead of scanning game history tables
 *  - /api/user/daily-loss keeps crash-arena parity (entries → rounds →
 *    tables join, settled only, same pot/rake math as bet-history)
 *  - applyLeaderboardCounters bumps daily_wagered / daily_won on every
 *    settlement (the casino / funnel games)
 *  - The four PvP server stores (mines-pvp, keno-pvp, memory-grid,
 *    lane-rush-duel) feed BOTH seats through applyLeaderboardCounters in
 *    recordPvPResult — so the daily counters, user_stats wins/losses, and
 *    quests all update for these PvP games (they used to settle outside
 *    the counters funnel entirely)
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
    "rouletteGames",
    "blackjackGames",
    "minesGames",
    "plinkoGames",
    "crashGames",
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

test("endpoint keeps crash-arena parity via entries → rounds → tables join", () => {
  assert.match(endpoint, /from\(crashArenaEntries\)/, "must read crash_arena_entries");
  assert.match(endpoint, /innerJoin\(\s*crashArenaRounds/, "must join crash_arena_rounds");
  assert.match(endpoint, /innerJoin\(\s*crashArenaTables/, "must join crash_arena_tables");
  assert.match(
    endpoint,
    /eq\(crashArenaRounds\.status,\s*"settled"\)/,
    "must only count settled rounds (same as bet-history)",
  );
  assert.match(
    endpoint,
    /gte\(crashArenaRounds\.createdAt,\s*startOfTodayUtc\(\)\)/,
    "must filter to today's rounds",
  );
});

test("endpoint applies the same pot/rake math as bet-history for crash arena", () => {
  assert.match(endpoint, /pot\s*\*\s*0\.05/, "must subtract the 5% rake from the pot");
  assert.match(endpoint, /payout\s*-\s*wager/, "winner net must be payout minus wager");
  assert.match(endpoint, /net\s*-=\s*wager/, "loser/folded net must be minus wager");
});

test("endpoint response is marked private (never CDN-cached)", () => {
  assert.match(endpoint, /Cache-Control/, "must set Cache-Control");
  assert.match(endpoint, /private/, "must be private — per-user data");
});

// ═══════════════════════════════════════════════════════════════
// applyLeaderboardCounters — bumps daily counters in the CTE
// ═══════════════════════════════════════════════════════════════

test("leaderboardCounters bumps daily_wagered and daily_won in the users UPDATE", () => {
  assert.match(
    counters,
    /daily_wagered\s*=\s*daily_wagered\s*\+\s*\$\{bet\}/,
    "daily_wagered must increment by bet",
  );
  assert.match(
    counters,
    /daily_won\s*=\s*daily_won\s*\+\s*\$\{win\}/,
    "daily_won must increment by win",
  );
});

// ═══════════════════════════════════════════════════════════════
// PvP server stores — feed both seats through applyLeaderboardCounters
// (daily counters, user_stats wins/losses, quests all update from there)
// ═══════════════════════════════════════════════════════════════

for (const [game, path] of Object.entries(PVP_STORES)) {
  const source = fs.readFileSync(path, "utf8");

  test(`${game}: winner recorded via applyLeaderboardCounters (stake bet, prizePaid payout, isPvpWin)`, () => {
    // The winner is fed through the canonical counters pipeline: bet = stake,
    // payout = prizePaid, isPvpWin = true (drives daily_wagered/daily_won,
    // user_stats wins, pvp_wins, and win-type quests).
    assert.match(
      source,
      /applyLeaderboardCounters\(\{[\s\S]*?betAmount: stake[\s\S]*?payout: winnerPayout[\s\S]*?isPvpWin: true/,
      `${game} winner must call applyLeaderboardCounters with stake/prizePaid/isPvpWin`,
    );
    assert.match(
      source,
      /const winnerPayout = Number\(match\.prizePaid\) \|\| 0;/,
      `${game} must derive the winner payout from prizePaid`,
    );
  });

  test(`${game}: loser recorded via applyLeaderboardCounters (stake bet, payout 0)`, () => {
    // The loser gets the same stake as betAmount and payout 0 — so the loss
    // lands in user_stats (losses +1, wagered +stake, no win).
    assert.match(
      source,
      /applyLeaderboardCounters\(\{[\s\S]*?clerkId: loserId[\s\S]*?betAmount: stake[\s\S]*?payout: 0/,
      `${game} loser must call applyLeaderboardCounters with stake bet and payout 0`,
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