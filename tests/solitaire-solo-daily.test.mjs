// tests/solitaire-solo-daily.test.mjs
//
// Solo Solitaire + Daily Challenge.
//
// Three layers are covered without a database:
//
//   1. the pure date/stat helpers (UTC day rules, streaks, empty states);
//   2. the real engine — the daily deal is deterministic and a submitted move
//      list is replayed/rejected by `replayMoves`, which is exactly what the API
//      does before recording anything;
//   3. the route/schema contracts that keep the modes isolated (own tables, no
//      ranked/Elo writers, one official daily row per user per date).

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  dailyDateKey,
  formatDuration,
  shiftDateKey,
  summariseDaily,
  summariseSolo,
} from "../src/lib/solitaire-duel/soloStats.js";
import { dailyDealFor, dailyDealSeed } from "../src/lib/solitaire-duel/daily.ts";
import { dealFromSeed } from "../src/lib/solitaire-duel/deck.ts";
import { initialStateFromDeal, replayMoves, viewForState } from "../src/lib/solitaire-duel/rules.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// ─── UTC date rules ─────────────────────────────────────────────────────────

test("the daily challenge day is the UTC calendar date", () => {
  assert.equal(dailyDateKey(Date.UTC(2026, 10, 8, 0, 0, 0)), "2026-11-08");
  assert.equal(dailyDateKey(Date.UTC(2026, 10, 8, 23, 59, 59)), "2026-11-08");
  // One millisecond earlier is the previous UTC day, even in a UTC-negative zone.
  assert.equal(dailyDateKey(Date.UTC(2026, 10, 8) - 1), "2026-11-07");
});

test("shiftDateKey handles month, year and leap-day boundaries", () => {
  assert.equal(shiftDateKey("2026-11-01", -1), "2026-10-31");
  assert.equal(shiftDateKey("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftDateKey("2028-02-28", 1), "2028-02-29");
  assert.equal(shiftDateKey("2028-02-29", 1), "2028-03-01");
  assert.equal(shiftDateKey("2026-11-08", 0), "2026-11-08");
});

// ─── Stats ─────────────────────────────────────────────────────────────────

test("solo summary reports empty states instead of invented numbers", () => {
  const empty = summariseSolo([]);
  assert.equal(empty.games, 0);
  assert.equal(empty.completed, 0);
  assert.equal(empty.completionRate, null);
  assert.equal(empty.bestMs, null);
  assert.equal(empty.averageMs, null);
});

test("solo summary computes completion rate, best and average from rows", () => {
  const summary = summariseSolo([
    { completed: true, moves: 100, elapsedMs: 60_000 },
    { completed: true, moves: 120, elapsedMs: 120_000 },
    { completed: false, moves: 40, elapsedMs: 30_000 },
  ]);
  assert.equal(summary.games, 3);
  assert.equal(summary.completed, 2);
  assert.equal(summary.completionRate, 66.7);
  assert.equal(summary.bestMs, 60_000);
  assert.equal(summary.averageMs, 90_000);
  assert.equal(summary.totalMoves, 260);
});

test("daily streak counts completed consecutive UTC days and breaks on a gap", () => {
  const today = "2026-11-08";
  const rows = [
    { challengeDate: "2026-11-06", completed: true, moves: 90, elapsedMs: 70_000 },
    { challengeDate: "2026-11-07", completed: true, moves: 95, elapsedMs: 65_000 },
    { challengeDate: "2026-11-08", completed: true, moves: 99, elapsedMs: 60_000 },
    // Not completed: must not extend the streak or count as a completion.
    { challengeDate: "2026-11-09", completed: false, moves: 4, elapsedMs: 5_000 },
  ];
  const summary = summariseDaily(rows, today);
  assert.equal(summary.completed, 3);
  assert.equal(summary.currentStreak, 3);
  assert.equal(summary.longestStreak, 3);
  assert.equal(summary.bestMs, 60_000);
  assert.equal(summary.today.completed, true);
});

test("yesterday's streak survives until a full day is missed", () => {
  const rows = [{ challengeDate: "2026-11-07", completed: true }];
  const summary = summariseDaily(rows, "2026-11-08");
  assert.equal(summary.currentStreak, 1);
  assert.equal(summary.today, null);

  const broken = summariseDaily([{ challengeDate: "2026-11-06", completed: true }], "2026-11-08");
  assert.equal(broken.currentStreak, 0);
  assert.equal(broken.longestStreak, 1);
});

test("longest streak is the best run ever, not just the current one", () => {
  const rows = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-11-08"].map(
    (challengeDate) => ({ challengeDate, completed: true }),
  );
  const summary = summariseDaily(rows, "2026-11-08");
  assert.equal(summary.longestStreak, 4);
  assert.equal(summary.currentStreak, 1);
});

test("formatDuration renders clock values and a dash when unknown", () => {
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(0), "—");
  assert.equal(formatDuration(65_000), "1:05");
  assert.equal(formatDuration(3_725_000), "1:02:05");
});

// ─── Engine: the daily deal and move verification ──────────────────────────

test("the same UTC date produces the same seed and the same deal", () => {
  const seed = dailyDealSeed("2026-11-08");
  assert.equal(seed, dailyDealSeed("2026-11-08"));
  assert.ok(Number.isInteger(seed) && seed >= 0 && seed <= 0xffff_ffff);

  const first = dailyDealFor("2026-11-08");
  const second = dailyDealFor("2026-11-08");
  assert.deepEqual(first, second, "a refresh must return the identical deal");
  // Different dates are different deals (not a constant fallback).
  assert.notEqual(dailyDealSeed("2026-11-08"), dailyDealSeed("2026-11-09"));
  assert.notDeepEqual(first.stock, dailyDealFor("2026-11-09").stock);
});

test("the daily deal opens a well-formed board with hidden cards projected away", () => {
  const deal = dailyDealFor("2026-11-08");
  const state = initialStateFromDeal(deal);
  assert.equal(state.tableau.length, 7);
  assert.equal(state.completed, false);
  assert.equal(state.ply, 0);
  const view = viewForState(state);
  assert.equal(view.completed, false);
  assert.equal(view.progress.foundationCards, 0);
  // Hidden identities must never reach a client view.
  for (const column of view.tableau) {
    for (const pile of column) {
      if (!pile.faceUp) assert.equal(pile.card, null);
    }
  }
});

test("the server rejects a submitted daily move list that is not legal", () => {
  const deal = dailyDealFor("2026-11-08");
  // First move of a fresh board cannot be waste-to-foundation: the waste is empty.
  const rejected = replayMoves({
    deal,
    moves: [{ kind: "waste-to-foundation", move: { kind: "waste-to-foundation", suit: "hearts" } }],
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.rejectedAt, 0);
  assert.equal(rejected.state.ply, 0, "a rejected move must not advance the board");
});

test("a legal opening draw replays, so recording is based on the engine's board", () => {
  const deal = dailyDealFor("2026-11-08");
  const replayed = replayMoves({
    deal,
    moves: [{ kind: "draw", move: { kind: "draw" } }],
  });
  assert.equal(replayed.ok, true);
  assert.equal(replayed.state.ply, 1);
  assert.equal(replayed.state.completed, false);
});

test("a solo deal is re-derivable by the server from the seed alone", () => {
  const seed = 123456789;
  assert.deepEqual(dealFromSeed(seed), dealFromSeed(seed));
  assert.notDeepEqual(dealFromSeed(seed), dealFromSeed(seed + 1));
});

// ─── Isolation + recording contracts ───────────────────────────────────────

test("solo and daily results have their own tables, never the ranked match table", () => {
  const schema = read("src/db/schema.ts");
  assert.match(schema, /export const solitaireSoloResults = pgTable\(\s*"solitaire_solo_results"/);
  assert.match(schema, /export const solitaireDailyResults = pgTable\(\s*"solitaire_daily_results"/);
  assert.match(
    schema,
    /solitaire_daily_results_user_date_unique/,
    "one official daily row per user per date must be enforced by the schema",
  );
});

test("the solo and daily routes verify moves server-side before writing", () => {
  const daily = read("src/app/api/solitaire/daily/route.ts");
  const solo = read("src/app/api/solitaire/solo/route.ts");

  for (const source of [daily, solo]) {
    assert.match(source, /replayMoves/);
    assert.doesNotMatch(source, /solitaire_duel_matches|solitaireDuelMatches/, "modes must not touch ranked rows");
    // No ranked writes: these routes insert into their own table only.
    assert.doesNotMatch(source, /\.update\(|\.delete\(/, "single-player routes must not update/delete ranked rows");
    assert.doesNotMatch(source, /eloStore|applyRating|recordRating|ratingHistory/);
    assert.doesNotMatch(source, /settleSolitaireDuelMatch|finalizeMatch/);
  }

  assert.match(daily, /onConflictDoNothing/);
  assert.match(daily, /challengeDate/);
  assert.match(daily, /dailyDealFor/, "the deal is server-derived, not client-supplied");
  assert.match(solo, /dealFromSeed\(seed\)/, "the solo deal is re-derived from the seed");
  assert.match(solo, /replayed\.state\.completed/, "completion is read from the replay");
});

test("the daily table has at most one official row per player per date", () => {
  const migration = read("src/db/migrations/0244_solitaire_solo_daily.sql");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "solitaire_solo_results"/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "solitaire_daily_results"/);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS "solitaire_daily_results_user_date_unique"[\s\S]*\("user_id", "challenge_date"\)/,
  );
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(migration, /DROP TABLE|DELETE FROM|TRUNCATE/i, "migration must be additive");
});

test("the daily migration is journaled for the migration guard", () => {
  const journalPath = "src/db/migrations/meta/_journal.json";
  assert.ok(existsSync(join(ROOT, journalPath)));
  const journal = JSON.parse(read(journalPath));
  const entry = journal.entries.find((row) => row.tag === "0244_solitaire_solo_daily");
  assert.ok(entry, "0244 must appear in the drizzle journal");
  assert.equal(entry.idx, 225);
});

test("the game surface never calls the matchmaking or AI endpoints", () => {
  const game = read("src/components/solitaire-duel/SoloSolitaireGame.tsx");
  assert.doesNotMatch(game, /create-or-join|create-ai|\/api\/solitaire-duel/);
  assert.match(game, /startedAtMs/, "the timer is timestamp-based");
  assert.match(game, /replayMoves/, "resume replays the move log through the engine");
});

test("the homepage and navigation expose all four ways to play", () => {
  const home = read("src/app/PageClient.jsx");
  assert.match(home, /href="\/solitaire"/);
  assert.match(home, /href="\/daily"/);
  assert.match(home, /href="#lobby"/);
  assert.match(home, /href="#practice"/);
  assert.match(home, /Ranked PvP/);
  assert.match(home, /Solo Solitaire/);
  assert.match(home, /Practice vs AI/);
  assert.match(home, /Daily Challenge/);

  const nav = read("src/components/navigation-bar.jsx");
  assert.match(nav, /"\/daily"/);
  assert.match(nav, /"\/classement"/);
});
