/**
 * Chess VS-AI difficulty — the DATABASE MODEL of the tier.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A match row is the contract between the migration, the Drizzle schema and
 * every reader. The Drizzle schema is NOT generated from the SQL, so a column
 * that exists in one place and not the other is a runtime 500 that only shows up
 * in production — which is exactly the failure `0206_uno_guest_seat.sql` caused
 * when it shipped unjournaled.
 *
 * It also pins the two properties that make this migration SAFE to add to a live
 * table: the vocabulary is CLOSED to the three shipped tiers, and the change is
 * additive to `ai_difficulty` alone — no seat, no result, no money column is
 * touched.
 *
 * Run: npm run test:chess-ai-difficulty-schema
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  CHESS_AI_DIFFICULTIES,
  DEFAULT_CHESS_AI_DIFFICULTY,
  chessAiDifficultyFromMatch,
  coerceChessAiDifficulty,
  isChessAiDifficulty,
} from "../src/lib/chessDifficulty.ts";

const read = (rel) =>
  fs.readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");

const SCHEMA = read("src/db/schema.ts");
const SQL = read("src/db/migrations/0211_chess_ai_difficulty.sql");
const JOURNAL = JSON.parse(read("src/db/migrations/meta/_journal.json"));

const TAG = "0211_chess_ai_difficulty";
const COLUMN = "ai_difficulty";
const CONSTRAINT = "chess_games_ai_difficulty_valid";

/** SQL with `--` comments stripped, so prose can never satisfy a code check. */
const stripSql = (sql) => sql.replace(/^\s*--.*$/gm, "");
const CODE = stripSql(SQL);

/** The Drizzle table block for chess_games, on its own. */
function chessGamesBlock() {
  const start = SCHEMA.indexOf('export const chessGames = pgTable("chess_games"');
  assert.ok(start > -1, "chessGames must be defined in src/db/schema.ts");
  const end = SCHEMA.indexOf("}));", start);
  assert.ok(end > start, "the chessGames block must terminate");
  return SCHEMA.slice(start, end);
}

const BLOCK = chessGamesBlock();

/** Every snake_case name the Drizzle block DECLARES as a column. */
const DECLARED = [
  ...[...BLOCK.matchAll(/\b(?:uuid|varchar|integer|bigint|boolean|timestamp|jsonb|text)\("([a-z0-9_]+)"/g)].map(
    (m) => m[1],
  ),
];

// ── 1. The migration is registered ────────────────────────────────────────

test("migration 0211 is in the journal, in its own ordered slot", () => {
  const entries = JOURNAL.entries;
  const index = entries.findIndex((entry) => entry.tag === TAG);
  assert.ok(index > -1, `${TAG} must be in _journal.json`);
  const entry = entries[index];

  // The migrator walks the journal array in order and reads `idx`, so a wrong
  // idx silently reorders or skips migrations.
  assert.equal(entry.idx, index);
  assert.equal(entry.version, JOURNAL.version);
  assert.equal(entry.breakpoints, true);

  const previous = entries.find((e) => e.tag === "0210_evaluation_results_unique_key");
  assert.ok(previous, "0210 must still be journaled");
  assert.ok(entry.idx > previous.idx, "0211 must apply after 0210");
  assert.ok(entry.when > previous.when, "a later migration must have a later `when`");
});

// ── 2. Additive, idempotent, and scoped to the one column ─────────────────

test("the migration only ALTERs chess_games and creates nothing", () => {
  assert.match(CODE, /ALTER TABLE "chess_games"/);
  assert.doesNotMatch(CODE, /CREATE TABLE/i);
  assert.doesNotMatch(CODE, /DROP\s+(TABLE|COLUMN)/i);
  // Idempotent: re-running the file on a database that already has the column
  // must be a no-op.
  assert.match(
    CODE,
    /ADD COLUMN IF NOT EXISTS "ai_difficulty" VARCHAR\(16\)/,
  );
});

test("no seat, result, or money column is touched", () => {
  // The tier is additive metadata. Seats and outcomes belong to a later stage,
  // and money no longer exists in chess at all.
  for (const untouched of [
    "player_white_id",
    "player_black_id",
    "winner_id",
    "status",
    "result",
    "payout",
    "bet_amount",
  ]) {
    assert.doesNotMatch(
      CODE,
      new RegExp(untouched),
      `0211 must not modify ${untouched}`,
    );
  }
  assert.doesNotMatch(
    CODE,
    /\b(stake|wagers?|stakes|payouts?|rake|prize|prizes|balance|balances|bet|bets)\b/i,
    "the tier column must not carry an economy",
  );
  assert.doesNotMatch(CODE, /chess_moves/, "0211 is about the game row only");
});

// ── 3. The column exists in BOTH representations ──────────────────────────

test("the column is declared in the Drizzle schema, with the same name", () => {
  assert.ok(
    DECLARED.includes(COLUMN),
    `${COLUMN} is missing from the chessGames Drizzle table`,
  );

  // The declaration is pinned EXACTLY — including that it is nullable. `notNull`
  // would force a value onto every PvP row, which has no bot and so has no tier.
  const declaration = BLOCK.split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("aiDifficulty:"));
  assert.ok(declaration, "aiDifficulty must be declared in the chessGames block");
  assert.equal(declaration, 'aiDifficulty: varchar("ai_difficulty", { length: 16 }),');
  assert.doesNotMatch(declaration, /notNull/);
  assert.doesNotMatch(CODE, /"ai_difficulty" VARCHAR\(16\) NOT NULL/);
});

// ── 4. The vocabulary is closed, and agrees with the module ───────────────

test("the vocabulary is exactly the three shipped tiers, enforced by a CHECK", () => {
  assert.match(CODE, new RegExp(CONSTRAINT));
  assert.match(CODE, /CHECK \(/);
  // NULL is the ONLY value outside the vocabulary.
  assert.match(
    CODE,
    /CHECK \("ai_difficulty" IS NULL OR "ai_difficulty" IN \(/,
  );

  const checkLine = CODE.split("\n").find((line) => line.includes("CHECK ("));
  assert.ok(checkLine, "the constraint must be a readable line");
  const sqlValues = [...checkLine.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);

  // THE DRIFT GUARD: the SQL list and the TypeScript list are the same set.
  assert.deepEqual(
    [...sqlValues].sort(),
    [...CHESS_AI_DIFFICULTIES].sort(),
    "the migration's allowed values must equal CHESS_AI_DIFFICULTIES",
  );
  assert.deepEqual([...sqlValues].sort(), ["easy", "hard", "medium"]);
});

test("the constraint is added idempotently, so re-running is safe", () => {
  // Guarded on the table existing AND the constraint not existing yet.
  assert.match(CODE, /IF EXISTS \(/);
  assert.match(CODE, /AND NOT EXISTS \(/);
  assert.match(CODE, /FROM pg_constraint WHERE conname = 'chess_games_ai_difficulty_valid'/);
  assert.match(CODE, /DO \$\$/);
});

// ── 5. Existing rows get a safe default ──────────────────────────────────

test("existing AI rows are backfilled, and PvP rows are left alone", () => {
  const update = CODE.slice(CODE.indexOf("UPDATE"));
  assert.match(update, /UPDATE "chess_games"/);
  assert.match(update, /SET "ai_difficulty" = 'medium'/);
  // Only AI rows, and only ones the column has never been written for.
  assert.match(update, /WHERE "is_ai_game" = true/);
  assert.match(update, /AND "ai_difficulty" IS NULL/);

  // The backfilled value and the module's default must be the same tier, or a
  // legacy row would be recorded as one thing and read as another.
  assert.equal(DEFAULT_CHESS_AI_DIFFICULTY, "medium");
  assert.match(update, new RegExp(`SET "ai_difficulty" = '${DEFAULT_CHESS_AI_DIFFICULTY}'`));
});

test("the migration is ordered so the constraint cannot reject the backfill", () => {
  // ADD COLUMN → backfill → CHECK. Adding the constraint before the backfill
  // would work here (the values are already legal) but would fail on any row the
  // backfill could not repair, so the order is pinned deliberately.
  const addIndex = CODE.indexOf("ADD COLUMN");
  const updateIndex = CODE.indexOf("UPDATE");
  const checkIndex = CODE.indexOf("ADD CONSTRAINT");
  assert.ok(addIndex > -1 && updateIndex > addIndex, "the column must exist before the backfill");
  assert.ok(checkIndex > updateIndex, "the constraint must be added last");
});

// ── 6. Reading a tier: defaults and rejection ────────────────────────────

test("a row with no tier reads as the documented default", () => {
  assert.equal(chessAiDifficultyFromMatch(null), "medium");
  assert.equal(chessAiDifficultyFromMatch({}), "medium");
  assert.equal(chessAiDifficultyFromMatch({ aiDifficulty: null }), "medium");
  assert.equal(chessAiDifficultyFromMatch({ aiDifficulty: "hard" }), "hard");
  assert.equal(chessAiDifficultyFromMatch({ aiDifficulty: "medium" }), "medium");
});

test("invalid difficulty is REJECTED strictly and coerced tolerantly", () => {
  // Strict: what a route must use to refuse input.
  for (const invalid of ["insane", "normal", "NORMAL", "Hard", "1", 1, null, undefined, {}]) {
    assert.equal(isChessAiDifficulty(invalid), false, `${JSON.stringify(invalid)} must be rejected`);
  }
  assert.equal(isChessAiDifficulty("hard"), true);

  // Tolerant: what a stored value must never break on. (`insane` is NOT in this
  // list — it is a deliberate alias for the hardest tier, below.)
  for (const value of [undefined, null, "", "   ", "not-a-tier", {}, [], NaN, Infinity]) {
    assert.equal(coerceChessAiDifficulty(value), DEFAULT_CHESS_AI_DIFFICULTY);
  }
  // The legacy spellings map onto the canonical tiers rather than defaulting —
  // the same aliases the shared casino-wide coercer understands.
  assert.equal(coerceChessAiDifficulty("normal"), "medium");
  assert.equal(coerceChessAiDifficulty("insane"), "hard");
  assert.equal(coerceChessAiDifficulty("beginner"), "easy");
  assert.equal(coerceChessAiDifficulty(1), "easy");
  assert.equal(coerceChessAiDifficulty(3), "medium");
  assert.equal(coerceChessAiDifficulty(5), "hard");
});

test("every canonical tier round-trips through the row reader", () => {
  for (const tier of CHESS_AI_DIFFICULTIES) {
    assert.equal(chessAiDifficultyFromMatch({ aiDifficulty: tier }), tier);
    assert.equal(coerceChessAiDifficulty(tier), tier);
  }
});
