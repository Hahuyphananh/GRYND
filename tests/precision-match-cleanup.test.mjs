// Precision — persistence + lifecycle guardrails.
//
// Precision's lobby and match state live in Postgres
// (`precision_lobbies` / `precision_matches`) instead of the two
// `globalThis` Maps that leaked matches and stranded rounds on a serverless
// deploy. These tests pin the properties that make that work:
//
//   1. No process-local state and no timers anywhere in the gameplay path —
//      the arming countdown and the bot's stop are stored INSTANTS.
//   2. Every mutation takes the match row `FOR UPDATE`, so "both seats
//      stopped" is atomic across instances.
//   3. Rows nothing can use again are reclaimed (waiting lobbies, finished
//      matches, abandoned matches) and a live match is never pruned.
//   4. A practice (vs AI) match is created in `ready_up` and armed by the
//      player's Ready click, so its countdown can never open at 0.
//   5. Leaving cancels the queue entry / removes the practice match /
//      forfeits a live PvP match.
//
// The rules themselves are unit-tested in `precision-ai.test.mjs`.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");

/** Drop comments so guards can't be satisfied (or tripped) by prose. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const store = read("src/lib/precision/serverStore.ts");
const storeCode = stripComments(store);
const engine = read("src/lib/precision/engine.ts");
const matchmaking = read("src/lib/precision/matchmaking.ts");
const createAiRoute = read("src/app/api/precision/create-ai/route.ts");
const joinRoute = read("src/app/api/precision/join-lobby/route.ts");
const leaveRoute = read("src/app/api/precision/leave/route.ts");
const getMatchRoute = read("src/app/api/precision/get-match/route.ts");
const schema = read("src/db/schema.ts");
const migration = read("src/db/migrations/0160_precision_persistence.sql");
const journal = read("src/db/migrations/meta/_journal.json");

test("the gameplay path holds no process-local state and schedules no timers", () => {
  for (const [name, source] of [
    ["serverStore.ts", storeCode],
    ["engine.ts", stripComments(engine)],
  ]) {
    assert.doesNotMatch(source, /(setTimeout|setInterval)\s*\(/, `${name} must not schedule timers`);
    // `globalThis.crypto` is a capability check; anchoring STATE on the
    // global object (`globalThis.__x` / `globalThis as typeof globalThis`) is
    // the pattern that made the queue and the matches per-instance.
    assert.doesNotMatch(source, /globalThis\.__/, `${name} must not anchor state on globalThis`);
    assert.doesNotMatch(
      source,
      /globalThis as typeof globalThis/,
      `${name} must not anchor state on globalThis`,
    );
    assert.doesNotMatch(source, /new Map\(/, `${name} must not hold a process-local store`);
  }
});

test("the countdown and the bot are stored instants the next read acts on", () => {
  // The arming reveal is driven by the stamped `countdownEndsAt` …
  assert.match(store, /isArmedRoundDue\(/);
  assert.match(store, /revealArmedRoundState\(/);
  assert.match(store, /serverTargetMs/);
  // … and the bot's stop by the stamped `aiStopAt` instant.
  assert.match(store, /aiStopAt/);
  assert.match(store, /computeStopTelemetry\(/);
  // Every read path applies them, so a frozen instance can never strand a round.
  assert.match(store, /export async function readMatch\(/);
  assert.match(getMatchRoute, /readMatch\(/);
});

test("every match mutation locks the row so multi-instance play is atomic", () => {
  const lockCount = (storeCode.match(/for\("update"\)/g) ?? []).length;
  assert.ok(lockCount >= 4, `expected FOR UPDATE in every mutating path, found ${lockCount}`);
  for (const fn of ["markPlayerReady", "recordRoundStop", "forfeitMatch", "resignMatch", "claimPayout"]) {
    assert.match(store, new RegExp(`function ${fn}\\(`), `${fn} is missing`);
  }
  // Two players clicking Join at once: the claim carries the status predicate,
  // so exactly one of them flips the row to active.
  assert.match(store, /export async function joinLobbyById\(/);
  assert.match(store, /eq\(precisionLobbies\.status, "waiting"\)/);
});

test("rows nothing can use again are reclaimed, on TTLs", () => {
  assert.match(store, /export async function sweepPrecisionGames\(/);
  assert.match(store, /LOBBY_TTL_MS/);
  assert.match(store, /MATCH_FINISHED_TTL_MS/);
  assert.match(store, /MATCH_ABANDONED_TTL_MS/);
  // The abandoned sweep targets NON-finished rows that stopped moving —
  // without it, a player who quit mid-match left a dead row that the next
  // routed player landed on.
  assert.match(
    store,
    /ne\(precisionMatches\.phase, "finished"\)[\s\S]{0,200}precisionMatches\.touchedAt/,
  );
  // A real transition refreshes the activity clock, so a LIVE match is never
  // the one that gets pruned.
  assert.match(store, /touchedAt: new Date\(now\)/);
  assert.match(store, /export async function removePrecisionMatch\(/);
  assert.match(store, /delete\(precisionMatches\)/);
  assert.match(store, /delete\(precisionLobbies\)/);
});

test("a practice match is created in ready_up and armed by the Ready click", () => {
  assert.match(createAiRoute, /createAiMatch\(/);
  assert.doesNotMatch(
    createAiRoute,
    /armRound|armMatchRound/,
    "arming at create time is the stale-countdown bug",
  );
  assert.match(store, /export async function createAiMatch\(/);
  assert.match(store, /"ready_up"/);
  // Both seats must be ready before the first round is armed.
  assert.match(store, /const allReady =/);
  assert.match(store, /if \(allReady\) \{[\s\S]{0,300}armRound\(/);
});

test("pairing a second player creates exactly one match behind the lobby", () => {
  assert.match(matchmaking, /export async function tryAutoMatch\(/);
  // SKIP LOCKED so concurrent callers walk past each other's rows instead of
  // blocking, and the match insert rides the same transaction as the claim.
  assert.match(matchmaking, /\.for\("update", \{ skipLocked: true \}\)/);
  assert.match(matchmaking, /createMatchForPairing\(\s*\{[\s\S]{0,200}\},\s*tx,?\s*\)/);
  // An id that already has a match is never joinable again.
  assert.match(joinRoute, /joinLobbyById\(/);
  assert.match(store, /This game has already started\./);
});

test("leaving tears the game down: cancel queue entry, remove practice, forfeit PvP", () => {
  assert.match(leaveRoute, /cancelQueueEntry\(/);
  assert.match(leaveRoute, /removePrecisionMatch\(/);
  assert.match(leaveRoute, /forfeitMatch\(/);
  assert.match(leaveRoute, /isPrecisionAiMatch\(/);
});

test("the canonical house columns are derived on every write", () => {
  assert.match(store, /function reportingColumns\(/);
  assert.match(store, /winnerId: winner\?\.userId \?\? null/);
  assert.match(store, /status: .*"finished".*"cancelled"/);
  assert.match(schema, /export const precisionMatches = pgTable\(/);
  assert.match(schema, /export const precisionLobbies = pgTable\(/);
  for (const column of [
    "player1_id",
    "player2_id",
    "winner_id",
    "status",
    "ended_at",
    "is_ai_game",
    "phase",
    "state",
    "pending_stops",
    "anomaly_ledger",
    "server_target_ms",
    "ai_stop_at",
    "payout_processed_at",
    "touched_at",
  ]) {
    assert.match(migration, new RegExp(`"${column}"`), `migration is missing ${column}`);
  }
});

test("the migration takes over the canonical tables without destroying the stub", () => {
  // Migration 0035 created an unwritten `precision_matches` stub; the real
  // columns need that name. The stub is renamed aside (kept, not dropped) so
  // any historical rows survive, and the block is guarded so a re-run is a
  // no-op.
  assert.match(migration, /RENAME TO "precision_matches_legacy_0035"/);
  assert.match(migration, /RENAME TO "precision_rounds_legacy_0035"/);
  assert.doesNotMatch(migration, /DROP TABLE/i);
  assert.match(migration, /to_regclass\('public\.precision_matches'\)/);
  assert.match(journal, /"tag": "0160_precision_persistence"/);
});
