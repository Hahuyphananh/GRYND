/**
 * competitive-streak-phase11.test.mjs
 *
 * Phase 11 contracts:
 *   * a finalized draw resets BOTH seats' current competitive streak and never
 *     lowers the best streak;
 *   * the journal is still the idempotency gate, so duplicate/concurrent
 *     settlements count once;
 *   * AI, guest and ghost seats never reach the writer;
 *   * the classement has two independent best-streak boards, one per game;
 *   * the query is paginated, index-backed, and never reads the retired
 *     aggregate `user_stats` streak columns.
 *
 * Source-level contracts: the runner has no database.
 *
 * Run: node --import tsx --test tests/competitive-streak-phase11.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  COMPETITIVE_STREAK_GAME_KEYS,
  COMPETITIVE_STREAK_LABELS,
  isCompetitiveStreakGameKey,
  normalizeCompetitiveStreakGameKey,
} from "../src/lib/competitiveStreakModel.ts";

const read = (path) => fs.readFileSync(path, "utf8");

const writer = read("src/lib/competitiveStreak.ts");
const model = read("src/lib/competitiveStreakModel.ts");
const queries = read("src/lib/leaderboardQueries.js");
const route = read("src/app/api/leaderboard/competitive-streak/route.js");
const page = read("src/app/classement/PageClient.jsx");
const duel = read("src/lib/solitaire-duel/serverStore.ts");
const puzzle = read("src/lib/solitaire-puzzle/settlement.ts");
const migration = read(
  "src/db/migrations/0267_competitive_streak_leaderboard_idx.sql",
);
const schema = read("src/db/schema.ts");
const journal = JSON.parse(
  read("src/db/migrations/meta/_journal.json"),
);

test("the model keeps the two ladders separate and normalizes one board", () => {
  assert.deepEqual([...COMPETITIVE_STREAK_GAME_KEYS], [
    "solitaire-duel",
    "solitaire-puzzle",
  ]);
  assert.equal(isCompetitiveStreakGameKey("solitaire-duel"), true);
  assert.equal(isCompetitiveStreakGameKey("solitaire-puzzle"), true);
  assert.equal(isCompetitiveStreakGameKey("chess"), false);
  assert.equal(normalizeCompetitiveStreakGameKey("chess"), "solitaire-duel");
  assert.equal(
    COMPETITIVE_STREAK_LABELS["solitaire-duel"],
    "Solitaire Ranked",
  );
  assert.equal(
    COMPETITIVE_STREAK_LABELS["solitaire-puzzle"],
    "Puzzle Ranked",
  );
});

test("draw is a real writer outcome: current resets, best only grows", () => {
  assert.match(writer, /export type CompetitiveOutcome = "win" \| "loss" \| "draw"/);
  assert.match(
    writer,
    /outcome !== "win" && outcome !== "loss" && outcome !== "draw"/,
  );
  assert.match(
    writer,
    /WHEN \$\{isWin\} THEN "user_competitive_streaks"\."current_streak" \+ 1/,
  );
  assert.match(writer, /ELSE 0/);
  assert.match(writer, /"best_streak" = GREATEST/);
  assert.match(
    writer,
    /ELSE "user_competitive_streaks"\."best_streak"/,
  );
  assert.match(
    writer,
    /ON CONFLICT \("match_id", "user_id", "game_key"\) DO NOTHING/,
  );
  assert.match(writer, /isGuestId\(clerkId\)/);
});

test("both settlement draw branches write both seats inside the transaction", () => {
  for (const [name, source, marker, player] of [
    ["solitaire-duel", duel, "if (outcome.result === RESULT.DRAW)", "match"],
    [
      "solitaire-puzzle",
      puzzle,
      "if (snapshot.result === PUZZLE_SESSION_RESULT.DRAW)",
      "snapshot",
    ],
  ]) {
    const start = source.indexOf(marker);
    const end = source.indexOf("return;", start);
    assert.ok(start >= 0, `${name} must branch on a draw`);
    const block = source.slice(start, end);
    assert.equal(
      (block.match(/outcome: "draw"/g) ?? []).length,
      2,
      `${name} must write one draw row per seat`,
    );
    assert.match(block, new RegExp(`clerkId: ${player}\\.player1Id`));
    assert.match(block, new RegExp(`clerkId: ${player}\\.player2Id`));
    assert.match(block, /tx,/);
  }

  // The draw branch is after the AI/guest/ghost gates.
  assert.match(duel, /if \(match\.isAi\) \{\s*return;/);
  assert.match(duel, /if \(match\.isGhost\) \{/);
  assert.match(duel, /isGuestId\(match\.player1Id\)/);
  assert.match(puzzle, /if \(snapshot\.isAi\) return;/);
  assert.match(puzzle, /snapshot\.status !== PUZZLE_SESSION_STATUS\.FINISHED/);
  assert.match(puzzle, /isGuestId\(snapshot\.player1Id\)/);

  // The retired aggregate counter writer is not part of either settlement.
  for (const [name, source] of [
    ["solitaire-duel", duel],
    ["solitaire-puzzle", puzzle],
  ]) {
    assert.doesNotMatch(source, /applyLeaderboardCounters/);
    assert.doesNotMatch(source, /user_stats/);
  }
});

test("the best-streak query reads one game from the authoritative table", () => {
  const start = queries.indexOf(
    "export async function fetchCompetitiveStreakLeaderboard",
  );
  const end = queries.indexOf(
    "export async function fetchWeeklyStreakLeaderboard",
    start,
  );
  assert.ok(start >= 0, "the competitive board query must exist");
  const query = queries.slice(start, end);

  assert.match(query, /normalizeCompetitiveStreakGameKey\(gameKey\)/);
  assert.match(query, /FROM user_competitive_streaks s/);
  assert.match(query, /LEFT JOIN player_ratings r/);
  assert.match(query, /WHERE s\.game_key = \$1 AND s\.best_streak > 0/);
  assert.match(
    query,
    /ROW_NUMBER\(\) OVER \(ORDER BY s\.best_streak DESC, s\.user_id ASC\)/,
  );
  assert.match(query, /LIMIT \$2 OFFSET \$3/);
  assert.match(query, /COALESCE\(r\.wins, 0\)/);
  assert.match(query, /COALESCE\(r\.losses, 0\)/);
  assert.doesNotMatch(query, /user_stats|current_streak AS/i);
});

test("the route exposes one normalized game and is read-only", () => {
  assert.match(route, /normalizeCompetitiveStreakGameKey\(searchParams\.get\("game"\)\)/);
  assert.match(route, /fetchCompetitiveStreakLeaderboard\(\{/);
  assert.match(route, /gameKey: game/);
  assert.match(route, /CacheKeys\.leaderboard\.competitiveStreak/);
  assert.match(route, /COMPETITIVE_STREAK_GAME_KEYS\.map/);
  assert.doesNotMatch(
    route,
    /recordCompetitiveResult\s*\(|INSERT INTO|UPDATE |DELETE FROM/,
  );
});

test("the classement offers separate Duel and Puzzle best-streak tabs", () => {
  assert.match(page, /"duel-best": "solitaire-duel"/);
  assert.match(page, /"puzzle-best": "solitaire-puzzle"/);
  assert.match(page, /"duel-best",\s*"puzzle-best"/);
  assert.match(page, /isCompetitiveStreakTab/);
  assert.match(page, /competitive-streak\?game=\$\{COMPETITIVE_STREAK_TABS\[tab\]\}/);
  assert.match(page, /COMPETITIVE_STREAK_LABELS/);
  assert.match(page, /getMetricValue[\s\S]*best_streak/);
  assert.match(page, /href=\{playHref\}/);
  assert.match(page, /"\/play\/puzzle-ranked"/);
});

test("the ordered index and its journal entry are present", () => {
  assert.match(
    migration,
    /CREATE INDEX IF NOT EXISTS "user_competitive_streaks_game_best_idx"/,
  );
  assert.match(
    migration,
    /"game_key", "best_streak" DESC, "user_id"/,
  );
  assert.match(schema, /user_competitive_streaks_game_best_idx/);
  assert.match(schema, /desc\(table\.bestStreak\)/);

  const entry = journal.entries.find(
    (candidate) =>
      candidate.tag === "0267_competitive_streak_leaderboard_idx",
  );
  assert.ok(entry, "0267 must be journaled or db:migrate skips it");
  assert.equal(entry.idx, 248);
});
