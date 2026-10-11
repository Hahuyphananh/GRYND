/**
 * speed-typing-outcome.test.mjs
 *
 * THE VERDICT THE PLAYER IS SHOWN, driven for real.
 *
 * THE BUG THIS FILE PINS. The match view decided win/loss by comparing the
 * settled row's `winnerId` against Clerk's `user.id`. A signed-out free-play
 * visitor has no Clerk id at all — the practice gate mints them a `guest_…`
 * identity (src/lib/auth/guestSession.ts) — so a guest who had just WON the race
 * was told they had LOST: they read "You finished — the race is yours" in the
 * arena, the server recorded them as the winner, and the result screen then
 * opened as a defeat with the opponent highlighted. Nothing was wrong with the
 * race; the verdict was being read from the wrong place.
 *
 * THE CONTRACT. The verdict is the SERVER's `result`, read against the seat the
 * SNAPSHOT says the viewer holds — which needs no Clerk id and therefore works
 * for a guest, a signed-in player, and a client whose Clerk session has not
 * hydrated yet. Ids survive only as the fallback for a row that names a winner
 * without a result, and even then they are the SNAPSHOT's ids (a guest id
 * counts), never Clerk's alone.
 *
 * Run:  node --import tsx --test tests/speed-typing-outcome.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { outcomeFor } from "../src/lib/speed-typing/ui.ts";

// The identity a signed-out practice player is handed: a synthetic id with no
// `users` row and no Clerk account behind it.
const GUEST = "guest_9f2c41ab";
const RIVAL = "user_rival";

test("outcome: a GUEST who finished first is told they won", () => {
  // The reported bug, in one assertion: the seat wins on the row's own `result`
  // and the viewer's own seat, with no Clerk id anywhere in sight.
  assert.equal(
    outcomeFor({
      result: "player1",
      winnerId: GUEST,
      viewerSeat: 1,
      viewerSeatId: GUEST,
    }),
    "win",
  );
});

test("outcome: a guest who lost is still told they lost", () => {
  // The fix must not turn every guest result into a win.
  assert.equal(
    outcomeFor({
      result: "player2",
      winnerId: RIVAL,
      viewerSeat: 1,
      viewerSeatId: GUEST,
    }),
    "loss",
  );
});

test("outcome: the verdict needs no viewer id at all", () => {
  // `result` + `viewerSeat` is the whole decision, so it survives a snapshot
  // that could not name a seat id, a Clerk session that has not hydrated, and
  // any viewer whose id the client simply does not hold.
  assert.equal(outcomeFor({ result: "player1", viewerSeat: 1 }), "win");
  assert.equal(outcomeFor({ result: "player2", viewerSeat: 1 }), "loss");
  assert.equal(outcomeFor({ result: "player1", viewerSeat: 2 }), "loss");
  assert.equal(outcomeFor({ result: "player2", viewerSeat: 2 }), "win");
});

test("outcome: a dead heat is a draw for both seats", () => {
  assert.equal(outcomeFor({ result: "tie", viewerSeat: 1 }), "draw");
  assert.equal(outcomeFor({ result: "tie", viewerSeat: 2 }), "draw");
  // Even on a row that also (inconsistently) names a winner: a tie has none.
  assert.equal(
    outcomeFor({ result: "tie", winnerId: RIVAL, viewerSeat: 1, viewerSeatId: GUEST }),
    "draw",
  );
});

test("outcome: the server's seat verdict outranks any id on the row", () => {
  // `result` is written from the winner SEAT by the store's settlement, so it is
  // the authoritative statement; the ids beside it are the same fact spelled a
  // second way. If they ever disagreed, the seat wins — that is what keeps a
  // guest (or a renamed id) from being handed the wrong result.
  assert.equal(
    outcomeFor({
      result: "player1",
      winnerId: RIVAL,
      viewerSeat: 1,
      viewerSeatId: GUEST,
    }),
    "win",
  );
});

test("outcome: a result with no viewer seat cannot be resolved", () => {
  // A stranger — or a snapshot that lost the viewer's seat — is told nothing,
  // never a default. The page only renders this for a seat it holds, and a
  // non-participant never receives the snapshot at all.
  assert.equal(outcomeFor({ result: "player1", viewerSeat: null }), null);
  assert.equal(outcomeFor({ result: "player2", viewerSeat: null }), null);
});

test("outcome: a row that names only a winner is resolved by the SNAPSHOT's ids", () => {
  // The fallback path: no `result` (a legacy row, or another writer's
  // settlement). The id it compares is the one the snapshot gives the viewer's
  // seat, so a guest id resolves correctly too — Clerk is never the only way.
  assert.equal(
    outcomeFor({ result: null, winnerId: GUEST, viewerSeat: 1, viewerSeatId: GUEST }),
    "win",
  );
  assert.equal(
    outcomeFor({ result: null, winnerId: RIVAL, viewerSeat: 1, viewerSeatId: GUEST }),
    "loss",
  );
  // Nothing to compare against: still no verdict, rather than a guess.
  assert.equal(outcomeFor({ result: null, winnerId: GUEST, viewerSeat: 1 }), null);
  assert.equal(outcomeFor({ result: null, winnerId: null, viewerSeat: 1, viewerSeatId: GUEST }), null);
});

test("outcome: an unresolved row has no verdict", () => {
  assert.equal(outcomeFor({ result: null, winnerId: null, viewerSeat: 1 }), null);
  assert.equal(outcomeFor({ viewerSeat: 2 }), null);
  assert.equal(outcomeFor({ result: "", viewerSeat: 1 }), null);
});

test("outcome: an unrecognised result string is never a win", () => {
  // A vocabulary value nothing in the game writes must not be read as a win by
  // accident — it falls to the id fallback, and to null when there is none.
  assert.equal(outcomeFor({ result: "player3", viewerSeat: 1, viewerSeatId: GUEST }), null);
  assert.equal(
    outcomeFor({ result: "player3", winnerId: GUEST, viewerSeat: 1, viewerSeatId: GUEST }),
    "win",
  );
});
