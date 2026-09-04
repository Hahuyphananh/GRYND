// tests/db-backup-restore.test.mjs
//
// Unit tests for the shared backup/restore SQL helpers
// (scripts/db-backup-lib.mjs). These cover the exact logic that makes a
// dump/restore correct without needing a live Postgres:
//
//   • qLiteral      — SQL literal escaping (data integrity on restore)
//   • qIdent        — identifier quoting
//   • splitStatements — dump file → statements (restore correctness)
//   • orderByDependencies — foreign-key ordering (parents before children)
//
// A round-trip smoke test builds a small dump from sample rows and re-
// splits it, proving the emit/split contract stays in sync.

import test from "node:test";
import assert from "node:assert/strict";
import {
  qIdent,
  qLiteral,
  splitStatements,
  orderByDependencies,
} from "../scripts/db-backup-lib.mjs";

// ── qLiteral ─────────────────────────────────────────────────────────
test("qLiteral renders scalars and nulls", () => {
  assert.equal(qLiteral(null), "NULL");
  assert.equal(qLiteral(undefined), "NULL");
  assert.equal(qLiteral(42), "42");
  assert.equal(qLiteral(-3.14), "-3.14");
  assert.equal(qLiteral(Infinity), "NULL"); // not representable → NULL
  assert.equal(qLiteral(true), "true");
  assert.equal(qLiteral(false), "false");
  assert.equal(qLiteral("hello"), "'hello'");
});

test("qLiteral escapes single quotes in strings (SQL injection / data safety)", () => {
  assert.equal(qLiteral("it's"), "'it''s'");
  assert.equal(qLiteral("a'; DROP TABLE users; --"), "'a''; DROP TABLE users; --'");
  assert.equal(qLiteral("O'Brien"), "'O''Brien'");
  assert.equal(qLiteral("'"), "''''");
});

test("qLiteral renders dates as ISO timestamptz", () => {
  const d = new Date("2026-09-04T12:30:45.000Z");
  assert.equal(qLiteral(d), "'2026-09-04T12:30:45.000Z'::timestamptz");
});

test("qLiteral treats bigint/numeric/uuid/enum values as quoted strings", () => {
  assert.equal(qLiteral("12345678901234567890"), "'12345678901234567890'");
  assert.equal(qLiteral("123.4500"), "'123.4500'");
  assert.equal(qLiteral("550e8400-e29b-41d4-a716-446655440000"), "'550e8400-e29b-41d4-a716-446655440000'");
});

// ── qIdent ───────────────────────────────────────────────────────────
test("qIdent quotes identifiers and doubles embedded double quotes", () => {
  assert.equal(qIdent("users"), '"users"');
  assert.equal(qIdent('weird"name'), '"weird""name"');
});

// ── splitStatements ──────────────────────────────────────────────────
test("splitStatements splits multi-line INSERTs and skips comments/blank lines", () => {
  const sql = [
    "-- header comment",
    "BEGIN;",
    "",
    "CREATE TABLE \"users\" (",
    "  \"id\" integer NOT NULL,",
    "  \"name\" text",
    ");",
    "-- users (2 rows)",
    "INSERT INTO \"users\" (\"id\", \"name\") VALUES",
    "  (1, 'a')",
    "  ,(2, 'b');",
    "COMMIT;",
  ].join("\n");
  const stmts = splitStatements(sql);
  assert.equal(stmts.length, 4);
  assert.equal(stmts[0], "BEGIN;");
  assert.match(stmts[1], /^CREATE TABLE "users"/);
  // Lines are trimmed by the splitter (statements run trimmed against the
  // server, so leading whitespace is irrelevant).
  assert.equal(stmts[2], 'INSERT INTO "users" ("id", "name") VALUES\n(1, \'a\')\n,(2, \'b\');');
  assert.equal(stmts[3], "COMMIT;");
});

test("splitStatements handles a semicolon inside a quoted literal (not a terminator)", () => {
  const sql = [
    "INSERT INTO \"chat\" (\"msg\") VALUES",
    "  ('hi; there')",
    "  ,('end;');",
    "COMMIT;",
  ].join("\n");
  const stmts = splitStatements(sql);
  assert.equal(stmts.length, 2);
  assert.equal(stmts[0], "INSERT INTO \"chat\" (\"msg\") VALUES\n('hi; there')\n,('end;');");
  assert.equal(stmts[1], "COMMIT;");
});

// ── orderByDependencies ──────────────────────────────────────────────
test("orderByDependencies places parents before children", () => {
  const tables = ["users", "games", "chat_messages", "reports", "user_stats"];
  const fkRows = [
    { child: "games", parent: "users" },
    { child: "user_stats", parent: "users" },
    { child: "chat_messages", parent: "users" },
    { child: "chat_messages", parent: "games" },
    { child: "reports", parent: "users" },
    { child: "reports", parent: "chat_messages" },
  ];
  const ordered = orderByDependencies(tables, fkRows);
  // Every table present once.
  assert.deepEqual([...ordered].sort(), [...tables].sort());
  // Parents come before children for every FK edge.
  for (const { child, parent } of fkRows) {
    assert.ok(
      ordered.indexOf(parent) < ordered.indexOf(child),
      `${parent} must precede ${child} (got ${ordered.join(", ")})`,
    );
  }
});

test("orderByDependencies tolerates cycles and self-references", () => {
  const tables = ["a", "b"];
  const fkRows = [
    { child: "a", parent: "b" },
    { child: "b", parent: "a" }, // cycle
    { child: "a", parent: "a" }, // self-ref (ignored)
  ];
  const ordered = orderByDependencies(tables, fkRows);
  assert.deepEqual(new Set(ordered), new Set(tables)); // both present, no hang
});

test("orderByDependencies is stable and complete for an empty FK set", () => {
  const tables = ["z", "a", "m"];
  assert.deepEqual(orderByDependencies(tables, []), tables);
});

// ── Round-trip: emit a dump from sample rows, re-split it ────────────
test("round-trip: literals emitted by the dump can be re-split into statements", () => {
  // Recreate the dump's INSERT layout using the same helpers the backup
  // script uses, then confirm splitStatements finds exactly one INSERT.
  const row1 = [1, "Alice O'Brien", null].map((v) => qLiteral(v)).join(", ");
  const row2 = [2, 'Bob — "the; boss"', true].map((v) => qLiteral(v)).join(", ");
  const dump = [
    "BEGIN;",
    'INSERT INTO "users" ("id", "name", "admin") VALUES',
    `  (${row1})`,
    `  ,(${row2});`,
    "COMMIT;",
  ].join("\n");

  const stmts = splitStatements(dump);
  assert.equal(stmts.length, 3);
  assert.match(stmts[1], /^INSERT INTO "users"/);
  assert.match(stmts[1], /Alice O''Brien/);
  assert.match(stmts[1], /the; boss/);
});