// tests/last-run-settlement.test.mjs
//
// Pure tests for the completion → settlement mapping, plus the invariants that
// make the migrations safe to review and apply:
//
//   * the new table is additive (IF NOT EXISTS, no DROP/ALTER of existing
//     columns) and its columns exist in both the SQL and src/db/schema.ts;
//   * every new migration is registered in the drizzle journal (the migrator
//     only reads `meta/_journal.json`);
//   * direct client access is denied on the new and canonical tables;
//   * a completion can never be planned with a missing or duplicated seat.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { completionMetadata, planSettlement } from "../src/lib/last-run/outcome.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

const COMPLETION = {
  matchId: "8d0f1a6e-1111-4c2b-9f34-aa11bb22cc33",
  seed: 123456789,
  queuedAt: 1_800_000_000_000,
  startedAt: 1_800_000_003_200,
  endedAt: 1_800_000_041_000,
  result: "player1",
  reason: "crash",
  player1Id: "user_ada",
  player2Id: "user_bo",
  durations: { player1: 37_800, player2: 21_400 },
  distances: { player1: 18_240, player2: 9_870 },
  playerCount: 2,
};

// ── Settlement plan ─────────────────────────────────────────────────────

test("plan: a player1 win makes seat 1 the winner and seat 2 the loser", () => {
  const plan = planSettlement({ ...COMPLETION, result: "player1" });
  assert.deepEqual(plan, {
    winnerClerkId: "user_ada",
    loserClerkId: "user_bo",
    result: "win",
    winnerId: "user_ada",
    outcome: "win",
  });
});

test("plan: a player2 win is reversed, never mirrored from the viewer", () => {
  const plan = planSettlement({ ...COMPLETION, result: "player2" });
  assert.equal(plan.winnerClerkId, "user_bo");
  assert.equal(plan.loserClerkId, "user_ada");
  assert.equal(plan.winnerId, "user_bo");
  assert.equal(plan.outcome, "win");
});

test("draw: both seats are journaled with result 'draw' and no winner id", () => {
  const plan = planSettlement({ ...COMPLETION, result: "draw" });
  assert.equal(plan.result, "draw");
  assert.equal(plan.winnerId, null);
  assert.equal(plan.outcome, "draw");
  // The shared writer still needs two distinct seats for a draw.
  assert.equal(plan.winnerClerkId, "user_ada");
  assert.equal(plan.loserClerkId, "user_bo");
});

test("plan: missing, identical or unknown seats are refused", () => {
  assert.equal(planSettlement({ ...COMPLETION, player1Id: "" }), null);
  assert.equal(planSettlement({ ...COMPLETION, player2Id: "   " }), null);
  assert.equal(planSettlement({ ...COMPLETION, player2Id: "user_ada" }), null);
  assert.equal(planSettlement({ ...COMPLETION, result: "tie" }), null);
  assert.equal(planSettlement({ ...COMPLETION, result: null }), null);
});

test("metadata: carries both participants, the outcome and server-measured numbers", () => {
  const plan = planSettlement(COMPLETION);
  const metadata = completionMetadata(COMPLETION, plan);

  assert.equal(metadata.gameKey, "last-run");
  assert.equal(metadata.result, "player1");
  assert.equal(metadata.reason, "crash");
  assert.equal(metadata.outcome, "win");
  assert.equal(metadata.winnerId, "user_ada");
  assert.equal(metadata.player1Id, "user_ada");
  assert.equal(metadata.player2Id, "user_bo");
  assert.equal(metadata.durationMs, 37_800);
  assert.deepEqual(metadata.survivalMs, { player1: 37_800, player2: 21_400 });
  assert.deepEqual(metadata.distance, { player1: 18_240, player2: 9_870 });
  assert.equal(metadata.seed, 123456789);
  // No simulation frames, no input log, no client claim.
  assert.equal(metadata.inputs, undefined);
  assert.equal(metadata.snapshot, undefined);
});

// ── Migration safety and journal registration ───────────────────────────

const MIGRATIONS_DIR = path.join(ROOT, "src/db/migrations");
// Strip `--` comments before asserting on statements: prose may legitimately
// mention a keyword (e.g. "not FORCE ROW LEVEL SECURITY") without executing it.
const migrationSql = (tag) =>
  read(`src/db/migrations/${tag}.sql`).replace(/--.*$/gm, "");

test("journal: 0232–0234 are registered after 0231, with idx === position", () => {
  const journal = JSON.parse(read("src/db/migrations/meta/_journal.json"));
  const tags = journal.entries.map((entry) => entry.tag);

  for (const tag of ["0232_ensure_match_lifecycle", "0233_last_run_matches", "0234_last_run_rls"]) {
    const index = tags.indexOf(tag);
    assert.ok(index >= 0, `${tag} is missing from meta/_journal.json`);
    assert.equal(journal.entries[index].idx, index, `${tag} has a broken idx`);
  }

  assert.ok(
    tags.indexOf("0232_ensure_match_lifecycle") > tags.indexOf("0231_hillstrike_match_clock"),
    "new migrations must be appended, never inserted",
  );
});

test("migrations: additive only, and safe to run repeatedly", () => {
  for (const tag of ["0232_ensure_match_lifecycle", "0233_last_run_matches", "0234_last_run_rls"]) {
    const sql = migrationSql(tag);
    assert.ok(fs.existsSync(path.join(MIGRATIONS_DIR, `${tag}.sql`)), `${tag}.sql must exist`);
    assert.ok(!/DROP\s+TABLE/i.test(sql), `${tag} must not drop a table`);
    assert.ok(!/ALTER\s+TABLE[^;]*\bDROP\b/i.test(sql), `${tag} must not drop a column`);
    assert.ok(!/TRUNCATE|DELETE\s+FROM/i.test(sql), `${tag} must not delete data`);
    assert.ok(
      !/CREATE\s+TABLE(?!\s+IF\s+NOT\s+EXISTS)/i.test(sql),
      `${tag} must create tables idempotently`,
    );
  }
});

test("last_run_matches: columns and constraints exist in SQL and schema.ts", () => {
  const sql = migrationSql("0233_last_run_matches");
  const body = sql.slice(
    sql.indexOf('CREATE TABLE IF NOT EXISTS "last_run_matches"'),
    sql.indexOf(');', sql.indexOf('CREATE TABLE IF NOT EXISTS "last_run_matches"')),
  );

  const columns = [...body.matchAll(/^\s{2}"([a-z0-9_]+)"/gm)].map((match) => match[1]);
  assert.deepEqual(columns, [
    "id",
    "player1_id",
    "player2_id",
    "winner_id",
    "result",
    "end_reason",
    "player1_distance",
    "player2_distance",
    "player1_survival_ms",
    "player2_survival_ms",
    "duration_ms",
    "seed",
    "rated",
    "started_at",
    "ended_at",
    "created_at",
  ]);

  const schema = read("src/db/schema.ts");
  const schemaBlock = schema.slice(
    schema.indexOf("export const lastRunMatches"),
    schema.indexOf("export const availabilityAlerts"),
  );
  for (const column of columns) {
    assert.ok(schemaBlock.includes(`"${column}"`), `schema.ts is missing ${column}`);
  }

  // Integrity rules the database itself enforces.
  assert.ok(sql.includes("last_run_matches_result_valid"));
  assert.ok(sql.includes("last_run_matches_winner_matches_result"));
  assert.ok(sql.includes("last_run_matches_distinct_players"));
  assert.ok(sql.includes("last_run_matches_time_order"));
  assert.ok(/CREATE UNIQUE INDEX[\s\S]*|"id" uuid PRIMARY KEY/.test(sql));
  assert.ok(sql.includes("last_run_matches_p1_idx"));
  assert.ok(sql.includes("last_run_matches_p2_idx"));
});

test("rls: clients are denied on the match record and the canonical lifecycle tables", () => {
  const sql = migrationSql("0234_last_run_rls");
  for (const table of ["last_run_matches", "match_lifecycle", "match_lifecycle_events"]) {
    assert.ok(
      sql.includes(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`),
      `${table} must enable RLS`,
    );
  }
  assert.ok(sql.includes("USING (false)"));
  assert.ok(sql.includes("WITH CHECK (false)"));
  // FORCE would also apply the policies to the owner the app connects as.
  assert.ok(!/FORCE ROW LEVEL SECURITY/i.test(sql));
});

test("settlement: no client can submit a winner, and the record is written once", () => {
  const settlement = read("src/lib/last-run/settlement.ts");
  assert.ok(settlement.includes("planSettlement(completion)"));
  assert.ok(settlement.includes(".onConflictDoNothing()"));
  assert.ok(settlement.includes("canTransitionMatchLifecycle"));
  assert.ok(
    settlement.includes('throw new Error("last-run: completion must name two distinct registered seats")'),
    "an unverifiable completion must abort the transaction",
  );

  // The routes that exist can never carry an outcome: only the input route
  // accepts a body, and it accepts two booleans.
  const input = read("src/app/api/last-run/match/[matchId]/input/route.ts");
  assert.ok(input.includes("submitInput("));
  assert.ok(!/winner|result|distance/i.test(input.split("export async function POST")[1] ?? ""));

  const result = read("src/app/api/last-run/match/[matchId]/result/route.ts");
  assert.ok(result.includes("await auth()"), "the persisted read requires a session");
  assert.ok(!/body\s*=|req\.json/.test(result), "the result route accepts no payload");
});
