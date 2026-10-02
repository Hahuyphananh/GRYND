/**
 * Materialized leaderboard ranks (migration 0200).
 *
 * These are source-level assertions: the runner has no database, so the
 * contract worth locking down is that the view exists with the shape the
 * refresh helper requires, and that the cron actually rebuilds it. A
 * materialized view that nothing refreshes silently rots — the exact failure
 * mode this test prevents.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

const MIGRATION = "src/db/migrations/0200_rating_leaderboard_mv.sql";
const HELPER = "src/lib/leaderboardView.ts";
const CRON = "src/app/api/jobs/weekly-reset/route.ts";
const JOURNAL = "src/db/migrations/meta/_journal.json";

test("migration creates the view with a per-game rank", () => {
  const sql = read(MIGRATION);

  assert.match(sql, /CREATE MATERIALIZED VIEW IF NOT EXISTS "rating_leaderboard_mv"/);
  // The rank must be partitioned per game, matching fetchRatingLeaderboard's
  // ROW_NUMBER() OVER (ORDER BY rating DESC, losses ASC, user_id ASC).
  assert.match(sql, /PARTITION BY r\.game_key/);
  assert.match(sql, /ORDER BY r\.rating DESC, r\.losses ASC, r\.user_id ASC/);
});

test("migration keeps the Overall-Elo aggregate and its thresholds", () => {
  const sql = read(MIGRATION);

  // The badge is a cross-game average over players with enough established
  // games. 10 and 3 must track PROVISIONAL_GAMES / OVERALL_MIN_GAMES in elo.js.
  const elo = read("src/lib/elo.js");
  assert.match(elo, /export const PROVISIONAL_GAMES = 10;/);
  assert.match(elo, /export const OVERALL_MIN_GAMES = 3;/);
  assert.match(sql, /WHERE r2\.games_rated >= 10/);
  assert.match(sql, /HAVING COUNT\(\*\) >= 3/);
});

test("a unique index exists so CONCURRENTLY refresh is possible", () => {
  const sql = read(MIGRATION);

  // REFRESH MATERIALIZED VIEW CONCURRENTLY requires a unique index; without
  // one the refresh helper's fast path would always throw.
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "rating_leaderboard_mv_rank_key"/);
  assert.match(sql, /ON "rating_leaderboard_mv" \("game_key", "rank", "user_id"\)/);
});

test("migration populates the view so it is never empty", () => {
  const sql = read(MIGRATION);

  // A plain REFRESH (allowed inside the migration transaction, unlike
  // CONCURRENTLY) means the view ships populated.
  assert.match(sql, /^REFRESH MATERIALIZED VIEW "rating_leaderboard_mv";/m);
  // No CONCURRENTLY *statement* — it is illegal inside the migration
  // transaction, so only the fallback comment may mention it.
  assert.doesNotMatch(sql, /^REFRESH MATERIALIZED VIEW CONCURRENTLY/m);
});

test("the refresh helper prefers CONCURRENTLY and falls back", () => {
  const src = read(HELPER);

  assert.match(src, /REFRESH MATERIALIZED VIEW CONCURRENTLY/);
  assert.match(src, /REFRESH MATERIALIZED VIEW \$\{VIEW\}/);
  // Fails soft: a refresh failure cannot take down the settlement cron.
  assert.match(src, /return true;/);
  assert.match(src, /return false;/);
  assert.doesNotMatch(src, /throw new/);
});

test("the weekly cron rebuilds the view", () => {
  const src = read(CRON);

  assert.match(src, /import \{ refreshRatingLeaderboardView \}/);
  assert.match(src, /await refreshRatingLeaderboardView\(\)/);
  // Surfaces the outcome so a silent no-op refresh is visible in the response.
  assert.match(src, /ratingsRefreshed/);
});

test("the migration is registered in the drizzle journal", () => {
  const journal = JSON.parse(read(JOURNAL));
  const last = journal.entries.at(-1);

  assert.equal(last.tag, "0200_rating_leaderboard_mv");
  assert.equal(last.idx, journal.entries.length - 1);
  // Idx must be strictly increasing or drizzle skips/rewinds migrations.
  const idxs = journal.entries.map((e) => e.idx);
  assert.deepEqual(idxs, [...idxs].sort((a, b) => a - b));
});
