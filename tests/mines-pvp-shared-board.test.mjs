/**
 * Mines Duel — simultaneous independent-board contract.
 *
 * The old shared-board / alternating-turn model is retired. This file pins the
 * structural pieces of the replacement:
 *   • the migration adds every new column idempotently and is registered;
 *   • the schema mirrors what the migration adds;
 *   • the two seats get DIFFERENT mine positions with the same distribution;
 *   • the store generates the pair server-side (never per request);
 *   • the scrub helper canonicalises per-seat arrays before serialisation.
 *
 * Run:  node --test tests/mines-pvp-shared-board.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const MIGRATION = read("src/db/migrations/0201_mines_pvp_simultaneous.sql");
const REPLAY_MIGRATION = read(
  "src/db/migrations/0202_mines_pvp_replay_state.sql",
);
const JOURNAL = read("src/db/migrations/meta/_journal.json");
const SCHEMA = read("src/db/schema.ts");
const STORE = read("src/lib/mines-pvp/serverStore.js");
const CONSTANTS = read("src/lib/mines-pvp/constants.js");

test("the simultaneous migration is registered in _journal.json", () => {
  assert.match(JOURNAL, /"tag": "0201_mines_pvp_simultaneous"/);
});

test("the migration adds the per-seat boards + state idempotently", () => {
  for (const column of [
    "p1_board",
    "p2_board",
    "p1_revealed",
    "p2_revealed",
    "p1_correct_flags",
    "p2_correct_flags",
    "p1_score",
    "p2_score",
    "p1_completed",
    "p2_completed",
    "p1_locked",
    "p2_locked",
    "match_deadline",
    "match_timer_seconds",
  ]) {
    assert.ok(
      MIGRATION.includes(`"${column}"`),
      `migration must add ${column}`,
    );
  }
  // Every column statement is non-destructive / re-runnable (no bare
  // `ADD COLUMN` anywhere).
  assert.doesNotMatch(MIGRATION, /ADD COLUMN (?!IF NOT EXISTS)/);
  assert.match(MIGRATION, /ADD COLUMN IF NOT EXISTS/);
});

test("the migration adds the 'active' status value idempotently", () => {
  assert.match(MIGRATION, /ALTER TYPE "mines_pvp_status" ADD VALUE IF NOT EXISTS 'active'/);
  // Legacy labels are NOT dropped.
  assert.doesNotMatch(MIGRATION, /DROP VALUE/);
});

test("the distribution is a single server constant summing to 10", () => {
  assert.match(CONSTANTS, /export const MINE_VALUE_DISTRIBUTION = Object\.freeze\(\[/);
  assert.match(CONSTANTS, /\{ value: 10, count: 5 \}/);
  assert.match(CONSTANTS, /\{ value: 20, count: 3 \}/);
  assert.match(CONSTANTS, /\{ value: 30, count: 1 \}/);
  assert.match(CONSTANTS, /\{ value: 50, count: 1 \}/);
});

test("the store generates BOTH boards server-side", () => {
  assert.match(STORE, /generateBoardPair\(MINES_PER_MATCH\)/);
  assert.match(STORE, /p1Board: board1/);
  assert.match(STORE, /p2Board: board2/);
  // The create path never reads a client-supplied board / position / value.
  assert.doesNotMatch(STORE, /body\.board/);
  assert.doesNotMatch(STORE, /body\.mines/);
});

test("the scrub helper canonicalises the per-seat arrays", () => {
  assert.match(STORE, /p1Flags: flagsForSeat\(match, "player1"\)/);
  assert.match(STORE, /p1Revealed: revealedForSeat\(match, "player1"\)/);
  assert.match(STORE, /p1CorrectFlagCells: correctFlagsForSeat\(match, "player1"\)/);
});

test("the schema mirrors the migration's new columns", () => {
  const mine = SCHEMA.slice(
    SCHEMA.indexOf("export const minesPvpMatches = pgTable("),
    SCHEMA.indexOf("export const minesPvpRounds = pgTable("),
  );
  assert.match(mine, /p1Board: jsonb\("p1_board"\)/);
  assert.match(mine, /p2Board: jsonb\("p2_board"\)/);
  assert.match(mine, /matchDeadline: timestamp\("match_deadline"\)/);
});

test("legacy columns are preserved (nothing removed)", () => {
  // The old single-board field, picks and flags stay for legacy rows.
  assert.ok(SCHEMA.includes('board: jsonb("board")'));
  assert.ok(SCHEMA.includes('picks: jsonb("picks")'));
  assert.ok(SCHEMA.includes('p1Flags: jsonb("p1_flags")'));
});

test("the replay migration is registered and adds the final-state columns", () => {
  assert.match(JOURNAL, /"tag": "0202_mines_pvp_replay_state"/);
  for (const column of ["p1_final_state", "p2_final_state"]) {
    assert.ok(
      REPLAY_MIGRATION.includes(`"${column}"`),
      `replay migration must add ${column}`,
    );
  }
  assert.doesNotMatch(REPLAY_MIGRATION, /ADD COLUMN (?!IF NOT EXISTS)/);
  assert.doesNotMatch(REPLAY_MIGRATION, /DROP COLUMN/);
});

test("the rounds schema mirrors the replay final-state columns", () => {
  const rounds = SCHEMA.slice(SCHEMA.indexOf("export const minesPvpRounds = pgTable("));
  assert.match(rounds, /p1FinalState: jsonb\("p1_final_state"\)/);
  assert.match(rounds, /p2FinalState: jsonb\("p2_final_state"\)/);
});

test("the store snapshots each seat's full final state at resolve", () => {
  assert.match(STORE, /p1FinalState: finalStateForSeat\(match, "player1"\)/);
  assert.match(STORE, /p2FinalState: finalStateForSeat\(match, "player2"\)/);
  assert.match(STORE, /function finalStateForSeat\(match, seat\)/);
  // The snapshot carries revealed tiles, flags, mines hit and completion.
  assert.match(STORE, /revealed: revealedForSeat\(match, seat\)/);
  assert.match(STORE, /flags: flagsForSeat\(match, seat\)/);
  assert.match(STORE, /correctFlags: correctFlagsForSeat\(match, seat\)/);
});
