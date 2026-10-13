/**
 * coin-leaderboards.test.mjs
 *
 * The two coin boards — "Biggest Coin Win" (users.biggest_win) and "Highest
 * All-Time Coins" (users.peak_balance) — must be rankable all-time, must not
 * be offered on the weekly tab (they have no weekly counter), and the UI must
 * label and format them.
 *
 * Run:  node --import tsx --test tests/coin-leaderboards.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  LEADERBOARD_CATEGORIES,
  WEEKLY_CATEGORIES,
  normalizeLeaderboardCategory,
  normalizeWeeklyLeaderboardCategory,
} from "../src/lib/leaderboardQueries.js";

const QUERIES = fs.readFileSync("src/lib/leaderboardQueries.js", "utf8");
const PAGE = fs.readFileSync("src/app/classement/PageClient.jsx", "utf8");

test("both coin categories are rankable all-time", () => {
  assert.ok(LEADERBOARD_CATEGORIES.includes("biggest_win"));
  assert.ok(LEADERBOARD_CATEGORIES.includes("peak_balance"));
  assert.equal(normalizeLeaderboardCategory("biggest_win"), "biggest_win");
  assert.equal(normalizeLeaderboardCategory("peak_balance"), "peak_balance");
});

test("the weekly board does not offer a category it cannot rank", () => {
  assert.ok(!WEEKLY_CATEGORIES.includes("biggest_win"));
  assert.ok(!WEEKLY_CATEGORIES.includes("peak_balance"));
  // An unknown-to-weekly category falls back to the headline metric.
  assert.equal(normalizeWeeklyLeaderboardCategory("biggest_win"), "wins");
  assert.equal(normalizeWeeklyLeaderboardCategory("peak_balance"), "wins");
});

test("the all-time config ranks the users-row high-water marks", () => {
  for (const column of ["biggest_win", "peak_balance"]) {
    assert.match(
      QUERIES,
      new RegExp(`userIdentityField\\(columns, "${column}"`),
      `${column} must be read from the users row`,
    );
    assert.match(
      QUERIES,
      new RegExp(`${column}: \\{\\s*\\n\\s*fields:`),
      `${column} must have an all-time config`,
    );
  }
  // Only a real payout/peak ranks — 0 means "never", not a tie.
  assert.ok(
    (QUERIES.match(/whereClause: `\$\{biggestWin\}::numeric > 0`/g) || []).length === 1,
  );
  assert.ok(
    (QUERIES.match(/whereClause: `\$\{peakBalance\}::numeric > 0`/g) || []).length === 1,
  );
});

test("the leaderboard UI labels and formats both coin boards", () => {
  assert.match(PAGE, /biggest_win: "Biggest Coin Win"/);
  assert.match(PAGE, /peak_balance: "Highest All-Time Coins"/);
  assert.match(PAGE, /case "biggest_win":/);
  assert.match(PAGE, /case "peak_balance":/);
  // Both render a coin value.
  assert.ok((PAGE.match(/coins`/g) || []).length >= 2);
});

test("the weekly tab cannot select an all-time-only coin board", () => {
  assert.match(
    PAGE,
    /ALL_TIME_ONLY_CATEGORIES = new Set\(\["pvp_wins", "biggest_win", "peak_balance"\]\)/,
  );
  assert.match(PAGE, /tab === "all-time" \? ALL_TIME_CATEGORIES : WEEKLY_CATEGORIES/);
  assert.match(PAGE, /ALL_TIME_ONLY_CATEGORIES\.has\(category\)/);
});

test("the peak-balance column ships with its migration", () => {
  const schema = fs.readFileSync("src/db/schema.ts", "utf8");
  assert.match(schema, /peakBalance: numeric\("peak_balance"/);
  const migration = fs.readFileSync(
    "src/db/migrations/0212_user_peak_balance.sql",
    "utf8",
  );
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "peak_balance"/);
  // The one-time clamp: legacy balances come down to the wallet ceiling.
  assert.match(migration, /WHERE "balance" > 100000\.00/);
  // The peak is captured BEFORE the clamp.
  assert.ok(
    migration.indexOf('SET "peak_balance" = GREATEST') <
      migration.indexOf('SET "balance" = 100000.00'),
    "peak_balance must be backfilled before the clamp",
  );
});
