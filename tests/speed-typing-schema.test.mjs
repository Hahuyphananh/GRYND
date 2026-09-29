/**
 * speed-typing-schema.test.mjs
 *
 * The DATABASE MODEL of a Speed Typing match: what migration 0191 and the
 * Drizzle schema agree the table carries.
 *
 * Why this file exists next to the behavioural suites: a match row is the whole
 * contract between the store, the socket layer, the boards and match history. A
 * column that exists in one place and not the other is a runtime 500 in
 * production and nothing else catches it, because the Drizzle schema is not
 * generated FROM the SQL.
 *
 * It also pins the persistence SHAPE — one table, no keystroke rows, no economy
 * column — which is the requirement that typing must never become an event log.
 *
 * Run:  node --import tsx --test tests/speed-typing-schema.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (rel) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

const SCHEMA = read("src/db/schema.ts");
const SQL_0190 = read("src/db/migrations/0190_speed_typing.sql");
const SQL_0191 = read("src/db/migrations/0191_speed_typing_race.sql");
const SQL = `${SQL_0190}\n${SQL_0191}`;
const JOURNAL = JSON.parse(read("src/db/migrations/meta/_journal.json"));

/** The drizzle table block for speed_typing_matches, on its own. */
function drizzleBlock() {
  const start = SCHEMA.indexOf("export const speedTypingMatches = pgTable(");
  assert.ok(start > -1, "speedTypingMatches must be defined in src/db/schema.ts");
  const end = SCHEMA.indexOf("\n);", start);
  return SCHEMA.slice(start, end);
}

const BLOCK = drizzleBlock();
/**
 * Every snake_case name the Drizzle block DECLARES: the first argument of each
 * column constructor plus each index name. Matching those call shapes (rather
 * than every quoted string in the block) keeps option values like
 * `{ mode: "number" }` out of the comparison.
 */
const DECLARED = [
  ...[...BLOCK.matchAll(/\b(?:uuid|varchar|integer|bigint|boolean|timestamp|jsonb|text)\("([a-z0-9_]+)"/g)].map(
    (m) => m[1],
  ),
  ...[...BLOCK.matchAll(/\bindex\("([a-z0-9_]+)"\)/g)].map((m) => m[1]),
];

/** SQL with `--` comments stripped, so prose can never satisfy a code check. */
const stripSql = (sql) => sql.replace(/^\s*--.*$/gm, "");

// ── 1. The migration is registered and additive ───────────────────────────

test("migration 0191 is in the journal, after the foundation migration", () => {
  const entries = JOURNAL.entries;
  const race = entries.find((entry) => entry.tag === "0191_speed_typing_race");
  const base = entries.find((entry) => entry.tag === "0190_speed_typing");
  assert.ok(race, "0191_speed_typing_race must be in _journal.json");
  assert.ok(base);
  assert.ok(race.idx > base.idx, "the race migration must apply after the table exists");
  assert.equal(race.version, JOURNAL.version);
});

test("the race migration only ALTERs the existing table (no second table)", () => {
  assert.match(SQL_0191, /ALTER TABLE speed_typing_matches/);
  assert.doesNotMatch(SQL_0191, /CREATE TABLE/i);
  // Every column is added with IF NOT EXISTS, so re-running is safe on a
  // database that already has part of the change.
  const adds = [...SQL_0191.matchAll(/ADD COLUMN IF NOT EXISTS ([a-z_]+)/g)].map((m) => m[1]);
  assert.ok(adds.length >= 12, `expected the race columns to be added, found ${adds.length}`);
});

// ── 2. Every required field, in BOTH representations ──────────────────────

/**
 * The fields the match must support, named as the SQL does. Each one has to be
 * in the migration AND declared in the Drizzle schema, or the store cannot read
 * or write it.
 */
const REQUIRED_COLUMNS = [
  // Identity and lifecycle (0190)
  "id",
  "player1_id",
  "player2_id",
  "status",
  // Server-selected prompt, by id + version, plus the seed it was chosen from
  "race_seed",
  "passage_id",
  "passage_version",
  // The server clock and the times a match is made of
  "created_at",
  "started_at",
  "go_at",
  "ended_at",
  // Authoritative progress and correct/incorrect information, per seat
  "player1_chars_typed",
  "player1_errors",
  "player2_chars_typed",
  "player2_errors",
  // Authoritative completion state, per seat
  "player1_completed_at",
  "player2_completed_at",
  // Winner / result
  "winner_id",
  "result",
  "resolution_reason",
  // The concurrency field and the authoritative blob
  "revision",
  "race_state",
  // Rating/trophy compatibility (practice matches never settle)
  "is_ai",
  "ai_difficulty",
];

for (const column of REQUIRED_COLUMNS) {
  test(`the match carries ${column} in both the SQL and the schema`, () => {
    assert.ok(
      new RegExp(`\\b${column}\\b`).test(SQL),
      `${column} is missing from the migrations`,
    );
    assert.ok(
      DECLARED.includes(column),
      `${column} is missing from the Drizzle table (or is spelled differently)`,
    );
  });
}

test("the drizzle table and the SQL share the exact same column names", () => {
  // Catches the classic drift: a name in one place and a different one in the
  // other, which type-checks and then fails at runtime.
  const missing = DECLARED.filter((name) => !new RegExp(`\\b${name}\\b`).test(SQL));
  assert.deepEqual(missing, [], `names declared only in schema.ts: ${missing.join(", ")}`);
  // And the comparison is not vacuous.
  assert.ok(DECLARED.length >= 20, `expected the full column set, saw ${DECLARED.length}`);
});

// ── 3. Constraints that keep the numbers honest ───────────────────────────

test("counts cannot be negative, and errors cannot exceed characters typed", () => {
  assert.match(SQL_0191, /speed_typing_matches_progress_nonnegative/);
  assert.match(SQL_0191, /player1_chars_typed >= 0/);
  assert.match(SQL_0191, /speed_typing_matches_errors_within_progress/);
  assert.match(SQL_0191, /player1_errors <= player1_chars_typed/);
});

test("a seat cannot complete before the race opened", () => {
  assert.match(SQL_0191, /speed_typing_matches_completed_after_go/);
  assert.match(SQL_0191, /player1_completed_at >= go_at/);
});

test("the resolution reason is a closed vocabulary, as is the seed range", () => {
  assert.match(SQL_0191, /speed_typing_matches_resolution_reason_valid/);
  for (const reason of ["finish", "deadline", "forfeit", "draw"]) {
    assert.match(SQL_0191, new RegExp(`'${reason}'`));
  }
  assert.match(SQL_0191, /speed_typing_matches_race_seed_range/);
  assert.match(SQL_0191, /race_seed <= 4294967295/);
});

test("the scheduler's due-race query has an index", () => {
  assert.match(SQL_0191, /CREATE INDEX IF NOT EXISTS speed_typing_matches_due_idx/);
  assert.match(SQL_0191, /ON speed_typing_matches\(status, go_at\)/);
  assert.match(BLOCK, /speed_typing_matches_due_idx/);
});

// ── 4. The persistence shape: no event log, no economy ────────────────────

test("a match is ONE table — typing never becomes a table of rows", () => {
  const speedTypingTables = [...SCHEMA.matchAll(/pgTable\(\s*\n?\s*"([a-z_]+)"/g)]
    .map((m) => m[1])
    .filter((name) => name.startsWith("speed_typing"));
  assert.deepEqual(speedTypingTables, ["speed_typing_matches"]);
  // And nothing anywhere in the migrations creates a keystroke event table.
  const migrationsDir = "src/db/migrations";
  const files = fs.readdirSync(path.join(process.cwd(), migrationsDir));
  for (const file of files.filter((name) => name.endsWith(".sql"))) {
    const sql = read(`${migrationsDir}/${file}`);
    assert.doesNotMatch(
      sql,
      /CREATE TABLE[^;]*(keystroke|keystrokes|key_?event|key_?log|typing_event)/i,
      `${file} must not create a per-keystroke table`,
    );
  }
});

test("nothing in the race columns can hold money", () => {
  // Comments stripped: the migration's header explains the ABSENCE of an
  // economy, and that prose must not read as an economy column. Word-bounded,
  // so a COMMENT saying "a correction never erases a mistake" is not a hit.
  assert.doesNotMatch(
    stripSql(SQL_0191),
    /\b(stake|wagers?|stakes|payout|payouts|rake|prize|prizes|balance|balances|bet|bets)\b/i,
  );
});

test("the passage TEXT is never a column — only the seed and the pair", () => {
  assert.doesNotMatch(SQL, /passage_text|prompt_text|typed_text/i);
  assert.match(SQL_0191, /ADD COLUMN IF NOT EXISTS passage_id VARCHAR\(64\)/);
  assert.match(SQL_0191, /ADD COLUMN IF NOT EXISTS passage_version INTEGER/);
});
