/**
 * player-level.test.mjs
 *
 * Tests the trophy-derived player level and the seven permanent rank tiers:
 *   * every rank boundary (level 1, 14/15, 29/30, 44/45, 59/60, 74/75,
 *     89/90, 100)
 *   * level 1 and level 100
 *   * progress percentages and the next-level requirement
 *   * permanent progression after losing trophies
 *   * players with no trophy history and with very high totals
 *   * the badge payload attached to public profile / leaderboard rows
 *   * the additive migration + server-authoritative peak (no client writes)
 *
 * Run: node --import tsx --test tests/player-level.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  MAX_LEVEL_TROPHIES,
  MAX_PLAYER_LEVEL,
  RANK_KEYS,
  RANK_TIERS,
  TROPHIES_PER_LEVEL,
  getPlayerProgression,
  levelFromTrophies,
  normalizeTrophies,
  rankForLevel,
  rankForRankKey,
  toPlayerLevelShape,
} from "../src/lib/playerLevel.js";

import { toOverallTrophyShape } from "../src/lib/trophyStore.js";

// ════════════════════════════════════════════════════════════════════════
// 1. Configuration and level maths
// ════════════════════════════════════════════════════════════════════════

test("config: 100 trophies per level, level 100 at the top, 7 ranks", () => {
  assert.equal(TROPHIES_PER_LEVEL, 100);
  assert.equal(MAX_PLAYER_LEVEL, 100);
  assert.equal(MAX_LEVEL_TROPHIES, 10_000);
  assert.equal(RANK_TIERS.length, 7);
  assert.deepEqual(RANK_KEYS, [
    "rookie",
    "contender",
    "challenger",
    "elite",
    "master",
    "grandmaster",
    "legend",
  ]);
  // The tiers tile the whole 1–100 ladder with no gap or overlap.
  assert.equal(RANK_TIERS[0].minLevel, 1);
  assert.equal(RANK_TIERS[RANK_TIERS.length - 1].maxLevel, MAX_PLAYER_LEVEL);
  for (let i = 1; i < RANK_TIERS.length; i += 1) {
    assert.equal(RANK_TIERS[i].minLevel, RANK_TIERS[i - 1].maxLevel + 1);
  }
});

test("levelFromTrophies: level 1 at 0, +1 every 100, capped at 100", () => {
  assert.equal(levelFromTrophies(0), 1);
  assert.equal(levelFromTrophies(1), 1);
  assert.equal(levelFromTrophies(99), 1);
  assert.equal(levelFromTrophies(100), 2);
  assert.equal(levelFromTrophies(199), 2);
  assert.equal(levelFromTrophies(200), 3);
  assert.equal(levelFromTrophies(9_900), 100);
  assert.equal(levelFromTrophies(10_000), 100);
  assert.equal(levelFromTrophies(25_000), 100);
  // Defensive input handling — never NaN / negative / a fabricated level.
  assert.equal(levelFromTrophies(-500), 1);
  assert.equal(levelFromTrophies("nope"), 1);
  assert.equal(levelFromTrophies(undefined), 1);
  assert.equal(normalizeTrophies(12.9), 12);
  assert.equal(normalizeTrophies(Infinity), 0);
});

test("rank boundaries: every tier starts and ends exactly where documented", () => {
  const expected = [
    [1, "rookie"],
    [14, "rookie"],
    [15, "contender"],
    [29, "contender"],
    [30, "challenger"],
    [44, "challenger"],
    [45, "elite"],
    [59, "elite"],
    [60, "master"],
    [74, "master"],
    [75, "grandmaster"],
    [89, "grandmaster"],
    [90, "legend"],
    [100, "legend"],
  ];
  for (const [level, rankKey] of expected) {
    assert.equal(rankForLevel(level).key, rankKey, `level ${level}`);
  }
  // Just outside each boundary lands in the neighbouring tier.
  assert.equal(rankForLevel(0).key, "rookie");
  assert.equal(rankForLevel(101).key, "legend");
  assert.equal(rankForLevel(14.9).key, "rookie");
  assert.equal(rankForRankKey("master").key, "master");
  assert.equal(rankForRankKey("unknown").key, "rookie");
});

// ════════════════════════════════════════════════════════════════════════
// 2. Progress percentage + next-level requirement
// ════════════════════════════════════════════════════════════════════════

test("progress: level 1 starts empty, 50 trophies is 50%, next level at 100", () => {
  const start = getPlayerProgression({ totalTrophies: 0 });
  assert.equal(start.level, 1);
  assert.equal(start.rankKey, "rookie");
  assert.equal(start.progressPercent, 0);
  assert.equal(start.currentLevelTrophies, 0);
  assert.equal(start.nextLevelTrophies, 100);
  assert.equal(start.trophiesToNext, 100);
  assert.equal(start.complete, false);

  const half = getPlayerProgression({ totalTrophies: 50 });
  assert.equal(half.level, 1);
  assert.equal(half.progressPercent, 50);
  assert.equal(half.trophiesToNext, 50);

  const nineNine = getPlayerProgression({ totalTrophies: 99 });
  assert.equal(nineNine.level, 1);
  assert.equal(nineNine.progressPercent, 99);
  assert.equal(nineNine.trophiesToNext, 1);

  const next = getPlayerProgression({ totalTrophies: 100 });
  assert.equal(next.level, 2);
  assert.equal(next.progressPercent, 0);
  assert.equal(next.currentLevelTrophies, 100);
  assert.equal(next.nextLevelTrophies, 200);
  assert.equal(next.trophiesToNext, 100);
});

test("progress: mid-ladder thresholds are exact", () => {
  const level45 = getPlayerProgression({ totalTrophies: 4_400 });
  assert.equal(level45.level, 45);
  assert.equal(level45.rankKey, "elite");
  assert.equal(level45.nextLevelTrophies, 4_500);
  assert.equal(level45.trophiesToNext, 100);

  const level56 = getPlayerProgression({ totalTrophies: 5_560 });
  assert.equal(level56.level, 56);
  assert.equal(level56.rankKey, "elite");
  assert.equal(level56.progressPercent, 60);
  assert.equal(level56.trophiesToNext, 40);
});

test("level 100: complete, 100%, no next-level requirement", () => {
  for (const total of [9_900, 10_000, 14_000]) {
    const top = getPlayerProgression({ totalTrophies: total });
    assert.equal(top.level, 100, `total ${total}`);
    assert.equal(top.rankKey, "legend");
    assert.equal(top.complete, true);
    assert.equal(top.progressPercent, 100);
    assert.equal(top.nextLevelTrophies, null);
    assert.equal(top.trophiesToNext, 0);
    assert.equal(top.maxLevel, 100);
  }
});

// ════════════════════════════════════════════════════════════════════════
// 3. Permanent progression / losing trophies
// ════════════════════════════════════════════════════════════════════════

test("permanent: losing trophies never lowers the earned level or rank", () => {
  const before = getPlayerProgression({
    totalTrophies: 9_200,
    peakTrophies: 9_200,
  });
  assert.equal(before.level, 93);
  assert.equal(before.rankKey, "legend");

  // −300 after three losses: current falls, the badge does not.
  const after = getPlayerProgression({
    totalTrophies: 8_900,
    peakTrophies: 9_200,
  });
  assert.equal(after.level, before.level);
  assert.equal(after.rankKey, before.rankKey);
  assert.equal(after.currentTrophies, 8_900);
  assert.equal(after.peakTrophies, 9_200);
  assert.equal(after.progressTrophies, 9_200);
  assert.equal(after.protected, true);
  assert.equal(after.progressPercent, before.progressPercent);
});

test("permanent: peak also protects a rank boundary (level 15 stays Contender)", () => {
  const afterLoss = getPlayerProgression({
    totalTrophies: 1_300,
    peakTrophies: 1_500,
  });
  assert.equal(afterLoss.level, 16);
  assert.equal(afterLoss.rankKey, "contender");
  assert.equal(afterLoss.protected, true);
});

test("no trophy history: level 1 Rookie, no fabricated trophies", () => {
  const fresh = getPlayerProgression({});
  assert.equal(fresh.level, 1);
  assert.equal(fresh.rankKey, "rookie");
  assert.equal(fresh.currentTrophies, 0);
  assert.equal(fresh.peakTrophies, 0);
  assert.equal(fresh.progressPercent, 0);
  assert.equal(fresh.protected, false);
});

test("high totals: capping the level does not cap the trophy count", () => {
  const high = getPlayerProgression({
    totalTrophies: 42_000,
    peakTrophies: 45_000,
  });
  assert.equal(high.level, 100);
  assert.equal(high.rankKey, "legend");
  assert.equal(high.currentTrophies, 42_000);
  assert.equal(high.peakTrophies, 45_000);
  assert.equal(high.progressPercent, 100);
});

// ════════════════════════════════════════════════════════════════════════
// 4. Badge data on public profile / leaderboard rows
// ════════════════════════════════════════════════════════════════════════

test("toPlayerLevelShape: compact row payload from the permanent peak", () => {
  assert.deepEqual(toPlayerLevelShape(0), {
    level: 1,
    rankKey: "rookie",
    rankNameKey: "playerLevel.ranks.rookie",
    maxLevel: 100,
    progressPercent: 0,
    complete: false,
  });
  const master = toPlayerLevelShape(7_400);
  assert.equal(master.level, 75);
  assert.equal(master.rankKey, "grandmaster");
  assert.equal(master.maxLevel, 100);
  // A lower current total is protected by the peak.
  assert.equal(toPlayerLevelShape(7_400, 6_000).level, 75);
});

test("toOverallTrophyShape: overall board rows carry level + peak", () => {
  const row = toOverallTrophyShape({
    clerk_id: "user_1",
    rank: 1,
    overall_trophies: 9_150,
    peak_total_trophies: 9_300,
    games_played: 8,
  });
  assert.equal(row.peakTotalTrophies, 9_300);
  assert.equal(row.overallTrophies, 9_150);
  assert.equal(row.playerLevel.level, 94);
  assert.equal(row.playerLevel.rankKey, "legend");

  // No trophy history → level 1, never a fabricated higher rank.
  const empty = toOverallTrophyShape({ overallTrophies: 0, gamesPlayed: 0 });
  assert.equal(empty.playerLevel.level, 1);
  assert.equal(empty.playerLevel.rankKey, "rookie");
});

// ════════════════════════════════════════════════════════════════════════
// 5. Migration + server-authoritative peak
// ════════════════════════════════════════════════════════════════════════

const MIGRATION = fs.readFileSync(
  new URL(
    "../src/db/migrations/0247_user_peak_total_trophies.sql",
    import.meta.url,
  ),
  "utf8",
);
const JOURNAL = JSON.parse(
  fs.readFileSync(
    new URL("../src/db/migrations/meta/_journal.json", import.meta.url),
    "utf8",
  ),
);
const TROPHY_STORE = fs.readFileSync(
  new URL("../src/lib/trophyStore.js", import.meta.url),
  "utf8",
);

test("migration 0247: additive column + safe backfill, registered in the journal", () => {
  assert.match(
    MIGRATION,
    /ADD COLUMN IF NOT EXISTS "peak_total_trophies" integer NOT NULL DEFAULT 0/,
  );
  assert.match(MIGRATION, /UPDATE "users" u/);
  assert.match(MIGRATION, /GREATEST\(/);
  assert.match(MIGRATION, /CREATE TRIGGER "player_trophies_sync_peak_total"/);
  // No destructive statement touches existing data.
  assert.doesNotMatch(MIGRATION, /DROP TABLE|DROP COLUMN|DELETE FROM|TRUNCATE/i);

  const entry = JOURNAL.entries.find(
    (item) => item.tag === "0247_user_peak_total_trophies",
  );
  assert.ok(entry, "migration is registered in meta/_journal.json");
  assert.equal(entry.idx, 228);
});

test("peak is maintained in Postgres, never submitted by a client", () => {
  // The trigger only ever raises the value.
  assert.match(MIGRATION, /peak_total_trophies.*GREATEST/s);
  assert.match(MIGRATION, /AFTER INSERT OR UPDATE OF "trophies"/);

  // Reads derive the level from the server-read peak, not a request value.
  assert.match(TROPHY_STORE, /peak_total_trophies/);
  assert.match(TROPHY_STORE, /getPlayerProgression\(\{/);
  assert.doesNotMatch(TROPHY_STORE, /req\.json\(\)|request\.json\(\)/);
});
