/**
 * streak-canonical.test.mjs
 *
 * Pins the Phase 2-6 wiring:
 *   * one ladder drives both titles and rewards;
 *   * Puzzle Ranked (move + forfeit) credits the daily streak;
 *   * both ranked settlements record the competitive win streak through the
 *     idempotent, transactional writer;
 *   * streak-only cosmetics are excluded from the grant-all and validated
 *     against `user_unlocks` on equip;
 *   * migration 0265 is additive and contains the backfill + tables.
 *
 * Run: node --import tsx --test tests/streak-canonical.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  STREAK_ITEM_IDS,
  STREAK_MILESTONES,
  STREAK_TITLE_MILESTONES,
  titleForDay,
  titleForStreak,
} from "../src/lib/streaks/schedule.js";
import { getAllStreakTitles } from "../src/lib/streakTitles.js";

const read = (path) => fs.readFileSync(path, "utf8");

test("one ladder drives the titles and the reward items", () => {
  assert.deepEqual(
    STREAK_TITLE_MILESTONES.map((entry) => entry.days),
    STREAK_MILESTONES.filter((entry) => entry.title).map((entry) => entry.day),
  );
  assert.deepEqual(
    getAllStreakTitles(),
    STREAK_TITLE_MILESTONES.map((entry) => entry),
  );
  assert.equal(titleForDay(1), "Daily Visitor");
  assert.equal(titleForDay(180), null); // reward-only day
  assert.equal(titleForStreak(4), "Loyal Player");
  assert.equal(titleForStreak(365), "King");
  assert.equal(titleForStreak(0), null);
});

test("Puzzle Ranked move and forfeit credit the daily streak", () => {
  const move = read("src/app/api/solitaire-puzzle/session/[sessionId]/move/route.ts");
  const forfeit = read("src/app/api/solitaire-puzzle/session/[sessionId]/forfeit/route.ts");

  assert.match(move, /recordStreakCompletion\(userId\)/);
  assert.match(move, /if \(result\.finished\)/);
  assert.match(forfeit, /recordStreakCompletion\(userId\)/);
});

test("both ranked settlements use the transactional competitive writer", () => {
  for (const path of [
    "src/lib/solitaire-duel/serverStore.ts",
    "src/lib/solitaire-puzzle/settlement.ts",
  ]) {
    const source = read(path);
    assert.match(source, /recordCompetitiveResult\(\{/);
    assert.match(source, /outcome: "win"/);
    assert.match(source, /outcome: "loss"/);
    assert.match(source, /outcome: "draw"/);
  }

  const writer = read("src/lib/competitiveStreak.ts");
  assert.match(writer, /ON CONFLICT \("match_id", "user_id", "game_key"\) DO NOTHING/);
  assert.match(writer, /"user_competitive_streaks"/);
  assert.match(writer, /isGuestId\(clerkId\)/);
});

test("streak-only cosmetics are earned, not granted", () => {
  const cosmetics = read("src/lib/cosmetics.ts");
  assert.match(cosmetics, /c\."streak_only" = FALSE/);
  assert.match(cosmetics, /catalog\.streakOnly/);
  assert.match(cosmetics, /userUnlocks\.itemId/);
  // Titles live in `special_titles`, not `cosmetics`, so the title half of the
  // grant-all needs its own exclusion derived from the shared streak ladder.
  assert.ok(STREAK_ITEM_IDS.includes("title_centurion"));
  assert.match(cosmetics, /STREAK_ONLY_TITLE_KEYS/);
  assert.match(cosmetics, /st\."key" NOT IN/);

  const engine = read("src/lib/streaks/server.ts");
  assert.match(engine, /userSpecialTitles/);
  assert.match(engine, /cosmeticKey: itemId, source: "streak"/);
});

test("migration 0265 is additive, backfills counts only, and adds the tables", () => {
  const migration = read("src/db/migrations/0265_streak_rewards_and_competitive.sql");
  for (const needle of [
    'ADD COLUMN IF NOT EXISTS "streak_only"',
    'ADD COLUMN IF NOT EXISTS "unlock_streak_day"',
    'CREATE TABLE IF NOT EXISTS "competitive_result_events"',
    'CREATE TABLE IF NOT EXISTS "user_competitive_streaks"',
    "'title_centurion'",
  ]) {
    assert.ok(migration.includes(needle), `migration must contain ${needle}`);
  }
  assert.match(migration, /INSERT INTO "user_streaks" \("user_id", "current_streak", "longest_streak"\)/);
  assert.doesNotMatch(migration, /last_completed_utc_date"\)\s*\nSELECT/);
  assert.doesNotMatch(migration, /DROP TABLE/i);
});
