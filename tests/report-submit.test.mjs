/**
 * Player-report submission — unit tests for src/lib/reports/submitReport.ts
 *
 * Runs the REAL production core (not a mirror) with a fake SQL so the whole
 * submit flow can be exercised outside of a running game / Next.js server:
 *
 *   node --import tsx --test tests/report-submit.test.mjs
 *
 * (or: npm run test:reports)
 *
 * Covered paths:
 *   • auth / validation (unauthorized, invalid reason, "other" details,
 *     details length cap, missing fields, self-report)
 *   • opponent resolution for hex-duel (numeric id, both seats, spectator,
 *     missing game, non-numeric id) and pool-masters (uuid match)
 *   • duplicate-report 429 + successful insert (asserting the exact
 *     INSERT parameters that would hit player_reports)
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  submitReport,
  ensurePlayerReportsTable,
  REPORT_DETAILS_MAX,
} from "../src/lib/reports/submitReport.ts";

// ════════════════════════════════════════════════════════════════════════
// Fake SQL — routes queries by their SQL text and records every call so
// tests can assert on the parameters that would hit the database.
// ════════════════════════════════════════════════════════════════════════

function makeFakeSql({
  hexDuelGames = [],
  poolMatches = [],
  recentReport = [],
} = {}) {
  const calls = [];
  const fn = async (strings, ...values) => {
    const sqlText = strings.join("?");
    calls.push({ sql: sqlText, values });
    if (/CREATE TABLE IF NOT EXISTS player_reports/.test(sqlText)) return [];
    if (/ALTER TABLE users/.test(sqlText)) return [];
    if (/CREATE INDEX IF NOT EXISTS idx_users_is_banned/.test(sqlText)) return [];
    if (/FROM hex_duel_games/.test(sqlText)) return hexDuelGames;
    if (/FROM pool_matches/.test(sqlText)) return poolMatches;
    if (/INSERT INTO player_reports/.test(sqlText)) return [];
    if (/FROM player_reports/.test(sqlText) && /LIMIT 1/.test(sqlText)) {
      return recentReport;
    }
    return [];
  };
  fn.calls = calls;
  return fn;
}

const VALID = {
  reportedClerkId: "user_opponent",
  gameType: "chess",
  gameId: "42",
  reason: "hacker",
  details: "",
};

// ════════════════════════════════════════════════════════════════════════
// Auth
// ════════════════════════════════════════════════════════════════════════

test("submitReport: unauthenticated (null userId) → 401", async () => {
  const r = await submitReport(null, { ...VALID }, { sql: makeFakeSql() });
  assert.equal(r.success, false);
  assert.equal(r.status, 401);
  assert.equal(r.error, "Unauthorized");
});

test("submitReport: unauthenticated (undefined userId) → 401", async () => {
  const r = await submitReport(undefined, { ...VALID }, { sql: makeFakeSql() });
  assert.equal(r.status, 401);
});

// ════════════════════════════════════════════════════════════════════════
// Body / reason validation
// ════════════════════════════════════════════════════════════════════════

test("submitReport: null body → 400 Invalid request body", async () => {
  const r = await submitReport("user_me", null, { sql: makeFakeSql() });
  assert.equal(r.status, 400);
  assert.equal(r.error, "Invalid request body");
});

test("submitReport: non-object body → 400 Invalid request body", async () => {
  const r = await submitReport("user_me", "nope", { sql: makeFakeSql() });
  assert.equal(r.status, 400);
  assert.equal(r.error, "Invalid request body");
});

test("submitReport: missing reason → 400", async () => {
  const r = await submitReport("user_me", { ...VALID, reason: "" }, { sql: makeFakeSql() });
  assert.equal(r.status, 400);
  assert.match(r.error, /Invalid reason/);
});

test("submitReport: unknown reason → 400", async () => {
  const r = await submitReport(
    "user_me",
    { ...VALID, reason: "made_up_reason" },
    { sql: makeFakeSql() },
  );
  assert.equal(r.status, 400);
  assert.match(r.error, /Invalid reason/);
});

test("submitReport: 'other' without details → 400", async () => {
  const r = await submitReport(
    "user_me",
    { ...VALID, reason: "other", details: "" },
    { sql: makeFakeSql() },
  );
  assert.equal(r.status, 400);
  assert.match(r.error, /Details are required/i);
});

test("submitReport: 'other' with whitespace-only details → 400", async () => {
  const r = await submitReport(
    "user_me",
    { ...VALID, reason: "other", details: "   " },
    { sql: makeFakeSql() },
  );
  assert.equal(r.status, 400);
  assert.match(r.error, /Details are required/i);
});

test("submitReport: details longer than the UI cap → 400", async () => {
  const r = await submitReport(
    "user_me",
    { ...VALID, reason: "other", details: "x".repeat(REPORT_DETAILS_MAX + 1) },
    { sql: makeFakeSql() },
  );
  assert.equal(r.status, 400);
  assert.match(r.error, new RegExp(`${REPORT_DETAILS_MAX} characters or fewer`));
});

test("submitReport: details exactly at the cap is accepted", async () => {
  const sql = makeFakeSql();
  const r = await submitReport(
    "user_me",
    { ...VALID, reason: "other", details: "x".repeat(REPORT_DETAILS_MAX) },
    { sql },
  );
  assert.equal(r.success, true);
  assert.equal(r.status, 200);
});

// ════════════════════════════════════════════════════════════════════════
// Required fields / self-report
// ════════════════════════════════════════════════════════════════════════

test("submitReport: missing reportedClerkId + gameType → 400", async () => {
  const r = await submitReport(
    "user_me",
    { reportedClerkId: "", gameType: "", reason: "hacker" },
    { sql: makeFakeSql() },
  );
  assert.equal(r.status, 400);
  assert.match(r.error, /Missing required fields/);
});

test("submitReport: self-report → 400", async () => {
  const r = await submitReport(
    "user_me",
    { ...VALID, reportedClerkId: "user_me" },
    { sql: makeFakeSql() },
  );
  assert.equal(r.status, 400);
  assert.equal(r.error, "You cannot report yourself");
});

// ════════════════════════════════════════════════════════════════════════
// Opponent resolution — hex-duel
// ════════════════════════════════════════════════════════════════════════

test("hex-duel: reporter is player1 → resolves to player2", async () => {
  const sql = makeFakeSql({
    hexDuelGames: [{ player1_id: "user_me", player2_id: "user_opp" }],
  });
  const r = await submitReport(
    "user_me",
    { reportedClerkId: "", gameType: "hex-duel", gameId: "7", reason: "hacker" },
    { sql },
  );
  assert.equal(r.success, true);
  const insert = sql.calls.find((c) => /INSERT INTO player_reports/.test(c.sql));
  assert.ok(insert, "expected an INSERT call");
  // [reporter, reported, game_type, game_id, reason, details]
  assert.equal(insert.values[0], "user_me");
  assert.equal(insert.values[1], "user_opp");
  assert.equal(insert.values[2], "hex-duel");
  assert.equal(insert.values[3], "7");
});

test("hex-duel: reporter is player2 → resolves to player1", async () => {
  const sql = makeFakeSql({
    hexDuelGames: [{ player1_id: "user_opp", player2_id: "user_me" }],
  });
  const r = await submitReport(
    "user_me",
    {
      reportedClerkId: "",
      gameType: "hex-duel",
      gameId: "9",
      reason: "toxic_player",
    },
    { sql },
  );
  assert.equal(r.success, true);
  const insert = sql.calls.find((c) => /INSERT INTO player_reports/.test(c.sql));
  assert.equal(insert.values[1], "user_opp");
});

test("hex-duel: 'player1' placeholder treated as missing → resolves via lookup", async () => {
  const sql = makeFakeSql({
    hexDuelGames: [{ player1_id: "user_me", player2_id: "user_opp" }],
  });
  const r = await submitReport(
    "user_me",
    {
      reportedClerkId: "player1",
      gameType: "hex-duel",
      gameId: "3",
      reason: "hacker",
    },
    { sql },
  );
  assert.equal(r.success, true);
  const insert = sql.calls.find((c) => /INSERT INTO player_reports/.test(c.sql));
  assert.equal(insert.values[1], "user_opp");
});

test("hex-duel: spectator (neither player) → 400 with clear error", async () => {
  const sql = makeFakeSql({
    hexDuelGames: [{ player1_id: "user_a", player2_id: "user_b" }],
  });
  const r = await submitReport(
    "user_spectator",
    { reportedClerkId: "", gameType: "hex-duel", gameId: "5", reason: "hacker" },
    { sql },
  );
  assert.equal(r.status, 400);
  assert.match(r.error, /Could not resolve the reported player/);
});

test("hex-duel: game row missing → 400 with clear error", async () => {
  const r = await submitReport(
    "user_me",
    { reportedClerkId: "", gameType: "hex-duel", gameId: "999", reason: "hacker" },
    { sql: makeFakeSql({ hexDuelGames: [] }) },
  );
  assert.equal(r.status, 400);
  assert.match(r.error, /Could not resolve the reported player/);
});

test("hex-duel: non-numeric gameId → 400 Invalid gameId", async () => {
  const r = await submitReport(
    "user_me",
    { reportedClerkId: "", gameType: "hex-duel", gameId: "abc", reason: "hacker" },
    { sql: makeFakeSql() },
  );
  assert.equal(r.status, 400);
  assert.match(r.error, /Invalid gameId/);
});

// ════════════════════════════════════════════════════════════════════════
// Opponent resolution — pool-masters (uuid match)
// ════════════════════════════════════════════════════════════════════════

test("pool-masters: reporter is player1 → resolves to player2 via uuid", async () => {
  const sql = makeFakeSql({
    poolMatches: [{ player1_id: "user_me", player2_id: "user_opp" }],
  });
  const r = await submitReport(
    "user_me",
    {
      reportedClerkId: "",
      gameType: "pool-masters",
      gameId: "11111111-2222-3333-4444-555555555555",
      reason: "hacker",
    },
    { sql },
  );
  assert.equal(r.success, true);
  const insert = sql.calls.find((c) => /INSERT INTO player_reports/.test(c.sql));
  assert.equal(insert.values[1], "user_opp");
});

test("pool-masters: reporter is player2 → resolves to player1", async () => {
  const sql = makeFakeSql({
    poolMatches: [{ player1_id: "user_opp", player2_id: "user_me" }],
  });
  const r = await submitReport(
    "user_me",
    {
      reportedClerkId: "",
      gameType: "pool-masters",
      gameId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      reason: "hacker",
    },
    { sql },
  );
  assert.equal(r.success, true);
  const insert = sql.calls.find((c) => /INSERT INTO player_reports/.test(c.sql));
  assert.equal(insert.values[1], "user_opp");
});

// ════════════════════════════════════════════════════════════════════════
// Direct report (no lookup) — the common path from most games
// ════════════════════════════════════════════════════════════════════════

test("direct report: reportedClerkId provided → no lookup, inserts as-is", async () => {
  const sql = makeFakeSql();
  const r = await submitReport(
    "user_me",
    { ...VALID, gameId: "42" },
    { sql },
  );
  assert.equal(r.success, true);
  // No hex_duel_games / pool_matches lookup should have happened.
  assert.ok(!sql.calls.some((c) => /FROM hex_duel_games/.test(c.sql)));
  assert.ok(!sql.calls.some((c) => /FROM pool_matches/.test(c.sql)));
  const insert = sql.calls.find((c) => /INSERT INTO player_reports/.test(c.sql));
  assert.equal(insert.values[1], "user_opponent");
  assert.equal(insert.values[2], "chess");
  assert.equal(insert.values[4], "hacker");
});

test("direct report: gameId null → INSERT with null game_id", async () => {
  const sql = makeFakeSql();
  const r = await submitReport(
    "user_me",
    { ...VALID, gameId: null },
    { sql },
  );
  assert.equal(r.success, true);
  const insert = sql.calls.find((c) => /INSERT INTO player_reports/.test(c.sql));
  assert.equal(insert.values[3], null);
});

test("direct report: details trimmed before insert", async () => {
  const sql = makeFakeSql();
  await submitReport(
    "user_me",
    { ...VALID, details: "  some detail  " },
    { sql },
  );
  const insert = sql.calls.find((c) => /INSERT INTO player_reports/.test(c.sql));
  assert.equal(insert.values[5], "some detail");
});

// ════════════════════════════════════════════════════════════════════════
// Dedupe + ensure-table wiring
// ════════════════════════════════════════════════════════════════════════

test("duplicate report within 5 minutes → 429", async () => {
  const sql = makeFakeSql({ recentReport: [{ id: 5 }] });
  const r = await submitReport("user_me", { ...VALID }, { sql });
  assert.equal(r.status, 429);
  assert.match(r.error, /already reported this player recently/);
  // No insert should have happened for a duplicate.
  assert.ok(!sql.calls.some((c) => /INSERT INTO player_reports/.test(c.sql)));
});

test("ensureTable is called before the dedupe check", async () => {
  const sql = makeFakeSql();
  const order = [];
  const ensureTable = async () => {
    order.push("ensure");
  };
  const fn = async (strings, ...values) => {
    order.push("sql:" + strings.join("?").slice(0, 80));
    return sql(strings, ...values);
  };
  fn.calls = sql.calls;
  const r = await submitReport("user_me", { ...VALID }, { sql: fn, ensureTable });
  assert.equal(r.success, true);
  const ensureIdx = order.indexOf("ensure");
  const dedupeIdx = order.findIndex((o) => o.includes("FROM player_reports"));
  assert.ok(ensureIdx >= 0, "ensureTable should run");
  assert.ok(dedupeIdx > ensureIdx, "dedupe should run after ensureTable");
});

test("ensureTable throwing → 500 Failed to submit report", async () => {
  const sql = makeFakeSql();
  const r = await submitReport(
    "user_me",
    { ...VALID },
    {
      sql,
      ensureTable: async () => {
        throw new Error("ddl boom");
      },
    },
  );
  assert.equal(r.status, 500);
  assert.equal(r.error, "Failed to submit report");
});

// ════════════════════════════════════════════════════════════════════════
// ensurePlayerReportsTable (self-healing DDL)
// ════════════════════════════════════════════════════════════════════════

test("ensurePlayerReportsTable issues the three idempotent DDL statements", async () => {
  const sql = makeFakeSql();
  await ensurePlayerReportsTable(sql);
  assert.ok(sql.calls.some((c) => /CREATE TABLE IF NOT EXISTS player_reports/.test(c.sql)));
  assert.ok(sql.calls.some((c) => /ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned/.test(c.sql)));
  assert.ok(sql.calls.some((c) => /CREATE INDEX IF NOT EXISTS idx_users_is_banned/.test(c.sql)));
  assert.equal(sql.calls.length, 3);
});

console.log("\n? All report-submit tests passed!\n");
