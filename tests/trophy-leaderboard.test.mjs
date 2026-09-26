/**
 * trophy-leaderboard.test.mjs
 *
 * Tests for the trophy leaderboard layer:
 *   * the pure Overall Trophies aggregate (sum, min-games gate)
 *   * the trophy Redis cache namespace + eager invalidation
 *   * the per-game and Overall Trophies routes (readers, caching, read-only)
 *
 * Run:  node --import tsx --test tests/trophy-leaderboard.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  OVERALL_TROPHIES_LABEL,
  OVERALL_TROPHY_MIN_GAMES,
  TROPHY_CONFIG,
  overallTrophiesFromCounts,
} from "../src/lib/trophies.js";

import {
  fetchTrophyLeaderboard,
  fetchOverallTrophyLeaderboard,
  toOverallTrophyShape,
  listTrophyGames,
} from "../src/lib/trophyStore.js";

import { CacheKeys, CacheTTL } from "../src/lib/redis/keys.ts";
import { invalidateTrophyBoards } from "../src/lib/redis/invalidation.ts";
import { RATED_GAMES } from "../src/lib/rating.js";

// ════════════════════════════════════════════════════════════════════════
// 1. The Overall Trophies aggregate
// ════════════════════════════════════════════════════════════════════════

test("config: overall trophies require the documented minimum games", () => {
  assert.equal(OVERALL_TROPHIES_LABEL, "Overall Trophies");
  assert.equal(OVERALL_TROPHY_MIN_GAMES, 3);
  assert.equal(TROPHY_CONFIG.overallMinGames, OVERALL_TROPHY_MIN_GAMES);
});

test("overallTrophiesFromCounts: sums played games and gates on the minimum", () => {
  // Below the gate → no Overall Trophies value at all.
  const partial = overallTrophiesFromCounts([
    { trophies: 9000, gamesRated: 300 }, // one game only
  ]);
  assert.equal(partial.eligible, false);
  assert.equal(partial.overallTrophies, null);
  assert.equal(partial.gamesPlayed, 1);

  // At the gate → the plain sum.
  const filled = overallTrophiesFromCounts([
    { trophies: 3000, gamesRated: 100 },
    { trophies: 1500, gamesRated: 50 },
    { trophies: 500, gamesRated: 20 },
  ]);
  assert.equal(filled.eligible, true);
  assert.equal(filled.overallTrophies, 5000);
  assert.equal(filled.gamesPlayed, 3);

  // An unplayed game (gamesRated 0) contributes nothing and does not qualify.
  const withUnplayed = overallTrophiesFromCounts([
    { trophies: 100, gamesRated: 5 },
    { trophies: 0, gamesRated: 0 },
  ]);
  assert.equal(withUnplayed.gamesPlayed, 1);
  assert.equal(withUnplayed.eligible, false);
});

test("overallTrophiesFromCounts: clamps each entry into the legal band", () => {
  const r = overallTrophiesFromCounts([
    { trophies: 999999, gamesRated: 1 },
    { trophies: -50, gamesRated: 1 },
    { trophies: 1000, gamesRated: 1 },
  ]);
  assert.equal(r.overallTrophies, 10000 + 0 + 1000);
});

test("overallTrophiesFromCounts: garbage input never throws or NaNs", () => {
  assert.deepEqual(overallTrophiesFromCounts(null), {
    overallTrophies: null,
    gamesPlayed: 0,
    eligible: false,
  });
  const r = overallTrophiesFromCounts([{ trophies: "nope", gamesRated: 1 }]);
  assert.equal(r.overallTrophies, null); // only one played game → gated
});

test("toOverallTrophyShape: normalizes aliases and stamps the label", () => {
  const shape = toOverallTrophyShape({
    name: "P",
    overall_trophies: 4200,
    games_played: 4,
  });
  assert.equal(shape.overallTrophies, 4200);
  assert.equal(shape.gamesPlayed, 4);
  assert.equal(shape.label, OVERALL_TROPHIES_LABEL);
});

test("listTrophyGames: mirrors the Elo registry exactly", () => {
  assert.deepEqual(
    listTrophyGames().map((g) => g.key),
    [...RATED_GAMES],
  );
  assert.equal(listTrophyGames()[0].label, "Chess");
});

// ════════════════════════════════════════════════════════════════════════
// 2. Cache namespace + invalidation
// ════════════════════════════════════════════════════════════════════════

test("CACHE: the trophy namespace has its own keys and TTL", () => {
  assert.equal(typeof CacheKeys.trophy.board, "function");
  assert.equal(CacheKeys.trophy.board("chess", 50, 0), "grynd:trophy:chess:50:0");
  assert.equal(CacheKeys.trophy.gameAll("chess"), "grynd:trophy:chess:*");
  assert.equal(CacheKeys.trophy.overall(50, 0), "grynd:trophy:overall:50:0");
  assert.equal(CacheKeys.trophy.overallAll, "grynd:trophy:overall:*");
  assert.equal(CacheKeys.trophy.all, "grynd:trophy:*");
  assert.equal(CacheTTL.trophy, 60);
  // Trophy keys must NOT sit under the leaderboard namespace, or the
  // debounced settlement purge would wipe every game's board.
  assert.doesNotMatch(CacheKeys.trophy.board("chess", 50, 0), /:lb:/);
});

test("CACHE: trophy boards are purged eagerly on settlement", () => {
  const src = fs.readFileSync("src/lib/redis/invalidation.ts", "utf8");
  assert.match(src, /export async function invalidateTrophyBoards/);
  assert.match(src, /CacheKeys\.trophy\.gameAll/);
  assert.match(src, /CacheKeys\.trophy\.overallAll/);
  // It must be wired into the settlement invalidation fan-out.
  assert.match(src, /invalidateTrophyBoards\(\)/);
  assert.equal(typeof invalidateTrophyBoards, "function");
});

// ════════════════════════════════════════════════════════════════════════
// 3. Routes (static contract checks — no DB)
// ════════════════════════════════════════════════════════════════════════

test("ROUTE: the per-game trophy board reads the trophy reader and cache", () => {
  const src = fs.readFileSync("src/app/api/leaderboard/trophy/route.js", "utf8");
  assert.match(src, /fetchTrophyLeaderboard/);
  assert.match(src, /CacheKeys\.trophy\.board/);
  assert.match(src, /CacheTTL\.trophy/);
  assert.match(src, /export async function GET/);
  // Read-only: no writer, no body.
  assert.doesNotMatch(src, /applyTrophyResult|await request\.json/);
});

test("ROUTE: the Overall Trophies board is read-only, rate-limited and capped", () => {
  const src = fs.readFileSync(
    "src/app/api/leaderboard/trophy-overall/route.js",
    "utf8",
  );
  assert.match(src, /fetchOverallTrophyLeaderboard/);
  assert.match(src, /CacheKeys\.trophy\.overall/);
  assert.match(src, /CacheTTL\.trophy/);
  assert.match(src, /consumeRateLimit/);
  assert.match(src, /MAX_OVERALL_OFFSET/);
  assert.doesNotMatch(src, /applyTrophyResult|await request\.json/);
});

test("ROUTE: neither trophy board ranks by a token/winnings metric", () => {
  for (const file of [
    "src/app/api/leaderboard/trophy/route.js",
    "src/app/api/leaderboard/trophy-overall/route.js",
  ]) {
    const src = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(src, /total_wagered|total_won|biggest_win|token/i);
  }
});

test("WRITER: the readers exist and are read-only (no writes in the leaderboard section)", () => {
  assert.equal(typeof fetchTrophyLeaderboard, "function");
  assert.equal(typeof fetchOverallTrophyLeaderboard, "function");
  const src = fs.readFileSync("src/lib/trophyStore.js", "utf8");
  // The leaderboard section must only SELECT.
  const section = src.slice(
    src.indexOf("// ── Leaderboards"),
    src.indexOf("// ── The authoritative writer"),
  );
  assert.match(section, /SELECT/);
  assert.doesNotMatch(section, /INSERT INTO|UPDATE player_trophies|DELETE FROM/i);
});
