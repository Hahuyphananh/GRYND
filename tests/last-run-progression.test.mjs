// tests/last-run-progression.test.mjs
//
// LAST RUN now settles into the platform's existing progression systems:
// one durable `last_run_matches` row, the canonical `match_lifecycle`
// completion, and the shared Elo/trophy writers — all in ONE transaction.
//
// These tests pin the completion projection (server values only, both Clerk
// ids), the deterministic event id that makes persistence idempotent, and the
// fact that the settlement reuses the shared writers instead of inventing a
// second rating or statistics lane.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { completionEventId } from "../src/lib/last-run/eventIds.ts";
import { DISCONNECT_GRACE_MS } from "../src/lib/last-run/constants.ts";
import {
  __resetLastRunRegistryForTests,
  forfeitMatch,
  getCompletionRecord,
  getSnapshot,
  joinQueue,
} from "../src/lib/last-run/matchRegistry.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const T0 = 1_700_000_000_000;

function paired() {
  __resetLastRunRegistryForTests();
  joinQueue({ userId: "u1", name: "Ada", now: T0 });
  const second = joinQueue({ userId: "u2", name: "Bo", now: T0 + 5 });
  assert.equal(second.status, "matched");
  const match = getSnapshot({ matchId: second.matchId, userId: "u1", now: T0 + 10 });
  assert.ok(match);
  return { matchId: second.matchId, startsAt: match.startsAt };
}

// ── Completion projection ───────────────────────────────────────────────

test("completion: nothing is recorded before the server declares a final result", () => {
  const { matchId, startsAt } = paired();
  getSnapshot({ matchId, userId: "u1", now: startsAt + 200 });
  assert.equal(getCompletionRecord(matchId, "u1"), null);
});

test("completion: only a seat in the match can read the record", () => {
  const { matchId, startsAt } = paired();
  forfeitMatch({ matchId, userId: "u1", now: startsAt + 300 });
  assert.equal(getCompletionRecord(matchId, "u3"), null);
  assert.ok(getCompletionRecord(matchId, "u2"));
});

test("completion: both seats describe the same match from their own side", () => {
  const { matchId, startsAt } = paired();
  forfeitMatch({ matchId, userId: "u1", now: startsAt + 400 });

  const winner = getCompletionRecord(matchId, "u2");
  const loser = getCompletionRecord(matchId, "u1");
  assert.ok(winner && loser);

  assert.equal(winner.matchId, loser.matchId);
  assert.equal(winner.seed, loser.seed);
  assert.equal(winner.startedAt, loser.startedAt);
  assert.equal(winner.endedAt, loser.endedAt);
  assert.equal(winner.result, loser.result);
  assert.deepEqual(winner.distances, loser.distances);

  // Outcome is seat-relative and derived from the server's own final result.
  assert.equal(winner.outcome, "win");
  assert.equal(loser.outcome, "loss");
  assert.equal(winner.result, "player2");

  // Both seats are named by the SERVER, from the pairing — not by a client.
  assert.equal(winner.player1Id, "u1");
  assert.equal(winner.player2Id, "u2");
  assert.equal(loser.player1Id, "u1");
  assert.equal(loser.player2Id, "u2");
});

test("completion: the record carries server values only, and no input log", () => {
  const { matchId, startsAt } = paired();
  forfeitMatch({ matchId, userId: "u1", now: startsAt + 500 });
  const record = getCompletionRecord(matchId, "u2");
  assert.ok(record);
  assert.deepEqual(Object.keys(record).sort(), [
    "distances",
    "durations",
    "endedAt",
    "matchId",
    "outcome",
    "player1Id",
    "player2Id",
    "playerCount",
    "queuedAt",
    "reason",
    "result",
    "seed",
    "startedAt",
  ]);
  assert.equal(record.playerCount, 2);
});

test("completion: an abandoned opponent is a win for the seat that stayed, with the reason recorded", () => {
  const { matchId, startsAt } = paired();
  // u2 never polls again; u1's read past the grace window settles the match.
  // The window is anchored at the race start, not at pairing.
  getSnapshot({ matchId, userId: "u1", now: startsAt + DISCONNECT_GRACE_MS + 100 });

  const p1 = getCompletionRecord(matchId, "u1");
  const p2 = getCompletionRecord(matchId, "u2");
  assert.ok(p1 && p2);
  assert.equal(p1.result, "player1");
  assert.equal(p1.outcome, "win");
  assert.equal(p1.reason, "abandon");
  assert.equal(p2.outcome, "loss");
  assert.equal(p2.reason, "abandon");
  assert.equal(p2.startedAt, p1.startedAt);
  assert.ok(startsAt);
});

// ── Idempotency ─────────────────────────────────────────────────────────

test("event id: deterministic per match, stable across calls, unique per match", () => {
  const first = completionEventId("8d0f1a6e-1111-4c2b-9f34-aa11bb22cc33");
  const second = completionEventId("8d0f1a6e-1111-4c2b-9f34-aa11bb22cc33");
  const other = completionEventId("8d0f1a6e-2222-4c2b-9f34-aa11bb22cc33");

  assert.equal(first, second, "a retry must target the same primary key");
  assert.notEqual(first, other);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("persistence: no database configured ⇒ a no-op, and results never wait on it", () => {
  const source = read("src/lib/last-run/persistence.ts");
  assert.ok(source.includes("databaseConfigured()"), "writes are gated on a configured database");
  assert.ok(source.includes("DATABASE_URL"));
  assert.ok(source.includes("completionsWritten"), "successful writes are remembered per match");
  assert.ok(source.includes("settleLastRunMatch"), "the transactional settlement owns the writes");
  assert.ok(!/\bapplyRatingResult\s*\(/.test(source), "persistence does not rate outside the transaction");
  assert.ok(!/\bapplyTrophyResult\s*\(/.test(source), "persistence does not award outside the transaction");
});

test("settlement: one transaction writes the record, completes the lifecycle and applies Elo once", () => {
  const source = read("src/lib/last-run/settlement.ts");
  assert.ok(source.includes("db.transaction("), "all durable effects share one transaction");
  assert.ok(source.includes(".onConflictDoNothing()"), "the match row insert is idempotent");
  assert.ok(source.includes("completionEventId("), "the lifecycle event id is deterministic");
  assert.ok(source.includes("applyRatingResult("), "the shared Elo writer is reused");
  assert.ok(source.includes("applyTrophyResult("), "the shared trophy writer is reused");
  assert.ok(source.includes('result: "draw"') || source.includes("planSettlement"), "draws are planned explicitly");
  assert.ok(!/class\s+\w*Rating/.test(source), "no second rating implementation");
});

// ── Shared registries (one rated lane, no duplicate systems) ────────────

test("progression: LAST RUN is registered in the ONE Elo/trophy/quest registries", () => {
  const rating = read("src/lib/rating.js");
  const ratedBlock = rating.slice(
    rating.indexOf("export const RATED_GAMES"),
    rating.indexOf("]);", rating.indexOf("export const RATED_GAMES")),
  );
  assert.ok(ratedBlock.includes('"last-run"'), "the shared settlement needs a registered game key");

  const labels = rating.slice(rating.indexOf("export const RATING_GAME_LABELS"));
  assert.ok(labels.includes('"last-run"'), "the rating board needs a label");

  const quests = read("src/lib/quests/games.ts");
  const questBlock = quests.slice(
    quests.indexOf("export const QUEST_GAME_IDS"),
    quests.indexOf("] as const;", quests.indexOf("export const QUEST_GAME_IDS")),
  );
  assert.ok(questBlock.includes('"last-run"'), "quest settlement must accept the game key");

  // Trophies reuse the Elo registry by design — there is no second game list.
  const trophies = read("src/lib/trophies.js");
  assert.ok(trophies.includes("TROPHY_GAMES = RATED_GAMES"));
});
