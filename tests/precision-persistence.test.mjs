// Precision — end-to-end persistence check against a REAL database.
//
// OPT-IN: this suite writes rows (it creates practice matches, pairs two
// throwaway users, and deletes what it made). It is skipped unless
// `PRECISION_DB_TESTS=1`, so the default test run never touches a database:
//
//   PRECISION_DB_TESTS=1 node --import tsx --env-file=.env.local \
//     --test tests/precision-persistence.test.mjs
//
// Prerequisite: migration 0160 (`npm run db:migrate`).
//
// It covers the paths that the in-memory store used to cheat on:
//   * a practice match is created in `ready_up` and does NOT pre-arm;
//   * one Ready click arms a FRESH countdown (so it can't open at 0);
//   * the arming reveal and the bot's stop both complete from a READ — no
//     timer anywhere (the old implementation needed a live process);
//   * a human stop + the bot's stop decide exactly one round;
//   * pairing two players produces one shared match id, and the joined id
//     can never be joined twice;
//   * forfeit / teardown / sweep leave nothing behind.

import test from "node:test";
import assert from "node:assert/strict";

import {
  PRECISION_AI_USER_ID,
  cancelQueueEntry,
  createAiMatch,
  forfeitMatch,
  joinLobbyById,
  markPlayerReady,
  readMatch,
  removePrecisionMatch,
  recordRoundStop,
  sweepPrecisionGames,
} from "../src/lib/precision/serverStore.ts";
import { tryAutoMatch } from "../src/lib/precision/matchmaking.ts";

const enabled = process.env.PRECISION_DB_TESTS === "1";
const aiUser = `precision-db-test-${Date.now()}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a read until `predicate` holds (the reveal + the bot's stop are driven
 *  by reads, so polling IS the mechanism under test). */
async function readUntil(matchId, predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let row = await readMatch(matchId);
  while (row && !predicate(row)) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${label} (last phase=${row.state.phase})`);
    }
    await sleep(300);
    row = await readMatch(matchId);
  }
  return row;
}

test("practice match: ready_up → armed → revealed → bot stop → round decided", { skip: !enabled }, async () => {
  const matchId = await createAiMatch(aiUser, "DB Test");
  try {
    // 1. Created in ready_up, NOT pre-armed (the stale-countdown bug).
    const fresh = await readMatch(matchId);
    assert.equal(fresh.state.phase, "ready_up");
    assert.equal(fresh.state.countdownEndsAt, null);
    assert.equal(fresh.state.targetMs, null);
    assert.equal(fresh.isAiGame, true);
    assert.equal(fresh.state.players[1].userId, PRECISION_AI_USER_ID);
    assert.equal(fresh.state.players[1].isReady, true, "the bot seat starts ready");

    // 2. The human's Ready click arms a countdown that is still in the future,
    //    with the target kept server-side.
    const ready = await markPlayerReady(matchId, aiUser);
    assert.equal(ready.bothReady, true);
    assert.equal(ready.match.phase, "arming");
    assert.ok(
      ready.match.countdownEndsAt - Date.now() > 3_000,
      "the countdown must have just started, not already elapsed",
    );
    assert.equal(ready.match.targetMs, null, "the target stays private while arming");

    const armed = await readMatch(matchId);
    assert.equal(armed.phase, "arming");
    assert.equal(armed.serverTargetMs !== null, true, "the rolled target is stored server-side");

    // 3. A READ performs the reveal once the countdown elapses.
    const active = await readUntil(matchId, (row) => row.state.phase === "active", "the round to open");
    assert.ok(active, "match disappeared before the round opened");
    assert.equal(typeof active.state.targetMs, "number");
    assert.equal(active.state.countdownEndsAt, null);
    assert.equal(typeof active.state.roundGoInstant, "number");
    assert.ok(active.aiStopAt !== null, "the bot's stop instant was scheduled at the reveal");

    // 4. The replay envelope is enforced while the round is live: a stale
    //    round id or nonce is refused and the round is NOT touched.
    await sleep(120); // clear MIN_STOP_MS
    const staleRound = await recordRoundStop(
      matchId,
      aiUser,
      "m-stale-round-0",
      active.state.roundNonce,
    );
    assert.equal(staleRound.validationError, true);
    assert.match(String(staleRound.error), /Round ID mismatch/i);
    const staleNonce = await recordRoundStop(
      matchId,
      aiUser,
      active.state.roundId,
      "not-the-live-nonce",
    );
    assert.equal(staleNonce.validationError, true);
    assert.match(String(staleNonce.error), /Nonce mismatch/i);
    const afterRejects = await readMatch(matchId);
    assert.equal(afterRejects.pendingStops[aiUser], undefined, "a rejected packet records nothing");

    // The human stops; the round resolves when the bot's stored instant is
    // applied by a later read.
    const stop = await recordRoundStop(
      matchId,
      aiUser,
      active.state.roundId,
      active.state.roundNonce,
    );
    assert.equal(stop.error, undefined);
    assert.equal(stop.validationError, false);

    const resolved = await readUntil(
      matchId,
      (row) => row.state.score.seat1 + row.state.score.seat2 > 0 || row.state.phase === "finished",
      "the round to be decided",
    );
    assert.equal(resolved.state.score.seat1 + resolved.state.score.seat2, 1);
    assert.equal(resolved.state.phase, "arming", "the next round is armed");
    assert.equal(resolved.state.currentRound, 2);
    assert.equal(resolved.state.lastRoundStops.seat1.elapsedMs > 0, true);
    // The decided round is closed: replaying its packet changes nothing.
    const replay = await recordRoundStop(
      matchId,
      aiUser,
      active.state.roundId,
      active.state.roundNonce,
    );
    assert.equal(replay.bothStopped, false);
    assert.ok(replay.error, "a stop for a decided round must be rejected");
    const afterReplay = await readMatch(matchId);
    assert.equal(afterReplay.state.score.seat1 + afterReplay.state.score.seat2, 1);

    // 5. Forfeit (what the disconnect grace timer does) ends it, then the row
    //    is gone for good.
    const forfeit = await forfeitMatch(matchId, aiUser);
    assert.equal(forfeit.ok, true);
    assert.equal(forfeit.match.winnerSeat, 2, "the opponent (bot) takes a forfeited match");
    assert.equal(forfeit.match.phase, "finished");
    assert.equal(await removePrecisionMatch(matchId), true);
    assert.equal(await readMatch(matchId), null);
  } finally {
    await removePrecisionMatch(matchId);
  }
});

test("pairing: two players get ONE shared match id and it can't be joined twice", { skip: !enabled }, async () => {
  const userA = `${aiUser}-a`;
  const userB = `${aiUser}-b`;
  const userC = `${aiUser}-c`;
  const wager = 1;
  let matchId = null;
  try {
    const first = await tryAutoMatch({ wager, hostUserId: userA, hostName: "A" });
    assert.equal(first.status, "waiting");
    matchId = first.gameId;

    // Idempotent re-queue: the same caller gets the SAME entry, not a second.
    const again = await tryAutoMatch({ wager, hostUserId: userA, hostName: "A" });
    assert.equal(again.status, "waiting");
    assert.equal(again.gameId, matchId);

    const second = await tryAutoMatch({ wager, hostUserId: userB, hostName: "B" });
    assert.equal(second.status, "matched");
    assert.equal(second.gameId, matchId, "the lobby id becomes the match id");

    const row = await readMatch(matchId);
    assert.equal(row.state.phase, "ready_up");
    assert.deepEqual(
      row.state.players.map((p) => p.userId),
      [userA, userB],
    );
    assert.equal(row.wager, wager);
    assert.equal(row.isAiGame, false);

    // Already paired → not a lobby any more, and not joinable by a third party.
    assert.equal(await cancelQueueEntry(matchId, userA), false);
    const third = await joinLobbyById({ lobbyId: matchId, userId: userC, userName: "C" });
    assert.equal(third.matchId, null);
    assert.equal(third.status, 409);
    assert.match(String(third.error), /already started/i);

    // Both seats must click Ready before a round is armed.
    const readyA = await markPlayerReady(matchId, userA);
    assert.equal(readyA.bothReady, false);
    assert.equal(readyA.match.phase, "ready_up");
    const readyB = await markPlayerReady(matchId, userB);
    assert.equal(readyB.bothReady, true);
    assert.equal(readyB.match.phase, "arming");
  } finally {
    if (matchId) await removePrecisionMatch(matchId);
  }
});

test("orphan cleanup: a waiting queue entry is cancelled only by its host", { skip: !enabled }, async () => {
  const host = `${aiUser}-host`;
  const wager = 1;
  const queued = await tryAutoMatch({ wager, hostUserId: host, hostName: "Host" });
  assert.equal(queued.status, "waiting");
  try {
    assert.equal(await cancelQueueEntry(queued.gameId, "someone-else"), false);
    assert.equal(await cancelQueueEntry(queued.gameId, host), true);
    assert.equal(await cancelQueueEntry(queued.gameId, host), false, "idempotent");
  } finally {
    await cancelQueueEntry(queued.gameId, host);
  }
});

test("the sweep is callable and reports what it reclaimed", { skip: !enabled }, async () => {
  const report = await sweepPrecisionGames();
  for (const key of ["waitingLobbies", "finishedMatches", "abandonedMatches", "staleLobbies"]) {
    assert.equal(typeof report[key], "number", `${key} must be a count`);
    assert.ok(report[key] >= 0);
  }
});
