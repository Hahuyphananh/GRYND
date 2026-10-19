/**
 * pool-stakes.test.mjs
 *
 * Pool Masters settles coins, so its winner must come from the SERVER's own
 * replay of the strokes — not from `gameState.winner`, which any client can
 * write. These tests pin the three pieces that make that true:
 *
 *   * `src/lib/pool/rack.ts`  — one deterministic rack, and the seat-keyed
 *     state the server replays from;
 *   * `src/lib/pool/shoot.ts` — a stroke is simulated with the page's own
 *     physics and ruled with the page's own rulebook, and two identical strokes
 *     from one table produce one identical result;
 *   * the routes — `/api/pool/submit-shot` is the only way a shot is applied,
 *     both seats are escrowed at join, and the pot pays 1.8× (10% rake).
 *
 * Run:  node --import tsx --test tests/pool-stakes.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  CUE_SPOT,
  createInitialPoolState,
  poolSeatFor,
  readPoolServerState,
  setupPoolBalls,
} from "../src/lib/pool/rack.ts";
import { applyPoolShot, normalizeShotInput, simulatePoolShot } from "../src/lib/pool/shoot.ts";
import { applyShotPower } from "../src/lib/pool/physics.ts";
import { POCKETS, TABLE_H, TABLE_W } from "../src/lib/pool/constants.ts";
import { pvpPotPayout } from "../src/lib/tokens/pvpPot.ts";

const read = (path) => fs.readFileSync(path, "utf8");

// The top-left corner pocket, and a cue placed in front of it.
const [CORNER_X, CORNER_Y] = POCKETS[0];
const SCRATCH_ANGLE = Math.atan2(CORNER_Y - 120, CORNER_X - 120);

// ════════════════════════════════════════════════════════════════════════
// 1. One rack, one state
// ════════════════════════════════════════════════════════════════════════

test("the rack is deterministic and complete", () => {
  const a = setupPoolBalls();
  const b = setupPoolBalls();
  assert.deepEqual(a, b, "the same rack every time");

  assert.equal(a.length, 16, "cue + 15 object balls");
  assert.equal(a[0].number, 0, "the cue ball leads");
  assert.equal(a[0].x, CUE_SPOT.x);
  assert.equal(a[0].y, CUE_SPOT.y);

  const numbers = a.map((ball) => ball.number).sort((x, y) => x - y);
  assert.deepEqual(
    numbers,
    Array.from({ length: 16 }, (_, i) => i),
    "every ball exactly once",
  );
  for (const ball of a) {
    assert.equal(ball.pocketed, false);
    assert.equal(ball.vx, 0);
    assert.equal(ball.vy, 0);
    assert.ok(ball.x > 0 && ball.x < TABLE_W, "racked on the table");
    assert.ok(ball.y > 0 && ball.y < TABLE_H, "racked on the table");
  }
});

test("a fresh state has no groups, no winner, and the drawn first turn", () => {
  const state = createInitialPoolState(2);
  assert.equal(state.turn, 2);
  assert.equal(state.team1, null);
  assert.equal(state.team2, null);
  assert.equal(state.openTable, true);
  assert.equal(state.winner, null);
  assert.equal(state.balls.length, 16);
});

test("the stored state reads back seat-keyed from either shape", () => {
  const balls = setupPoolBalls();

  // Written by submit-shot: already seat-keyed.
  const seatKeyed = readPoolServerState({
    balls,
    turn: 2,
    team1: "solids",
    team2: "stripes",
    winner: 2,
  });
  assert.equal(seatKeyed.team1, "solids");
  assert.equal(seatKeyed.team2, "stripes");
  assert.equal(seatKeyed.turn, 2);
  assert.equal(seatKeyed.winner, 2);

  // Written by the page's live sync: the SHOOTER's view, re-keyed by seat.
  const fromSeat1 = readPoolServerState({
    balls,
    turn: 1,
    perspectiveSeat: 1,
    myTeam: "stripes",
    oppTeam: "solids",
  });
  assert.equal(fromSeat1.team1, "stripes");
  assert.equal(fromSeat1.team2, "solids");

  const fromSeat2 = readPoolServerState({
    balls,
    turn: 1,
    perspectiveSeat: 2,
    myTeam: "solids",
    oppTeam: "stripes",
  });
  assert.equal(fromSeat2.team1, "stripes");
  assert.equal(fromSeat2.team2, "solids");

  // No balls yet (the row the lobby inserts) → the caller seeds the rack.
  assert.equal(readPoolServerState({ started: true, turn: 1 }), null);
  assert.equal(readPoolServerState(null), null);
});

test("the seat lookup only ever returns a seat the caller holds", () => {
  const match = { player1Id: "alice", player2Id: "bob" };
  assert.equal(poolSeatFor(match, "alice"), 1);
  assert.equal(poolSeatFor(match, "bob"), 2);
  assert.equal(poolSeatFor(match, "mallory"), null);
  assert.equal(poolSeatFor(match, null), null);
  assert.equal(poolSeatFor(match, undefined), null);
});

// ════════════════════════════════════════════════════════════════════════
// 2. The stroke is simulated, then ruled
// ════════════════════════════════════════════════════════════════════════

test("shot input is normalised and never carries NaN or an out-of-range pull", () => {
  assert.equal(normalizeShotInput(null), null);
  assert.equal(normalizeShotInput({ angle: "x", pull: 10 }), null);
  assert.equal(normalizeShotInput({ angle: 1 }), null);

  const shot = normalizeShotInput({
    angle: Math.PI,
    pull: 9_999,
    spinX: 9,
    spinY: -9,
    cueX: -500,
    cueY: 5_000,
  });
  assert.equal(shot.pull, 120);
  assert.equal(shot.spinX, 1);
  assert.equal(shot.spinY, -1);
  assert.ok(shot.cueX >= 0 && shot.cueX <= TABLE_W);
  assert.ok(shot.cueY >= 0 && shot.cueY <= TABLE_H);
});

test("the same stroke from the same table always lands the same way", () => {
  const state = createInitialPoolState(1);
  const shot = { angle: -Math.PI / 2, pull: 120 };

  const first = simulatePoolShot(state.balls, shot);
  const second = simulatePoolShot(state.balls, shot);
  assert.deepEqual(first.balls, second.balls, "deterministic rollout");
  assert.equal(first.ticks, second.ticks);

  // Everything is at rest in the returned table: the server never stores a
  // half-rolling board.
  for (const ball of first.balls) {
    assert.equal(ball.vx, 0);
    assert.equal(ball.vy, 0);
    assert.equal(ball.animatingPocket ?? false, false);
  }

  // The input table was not mutated (a rejected shot must not move the rack).
  assert.deepEqual(state.balls, setupPoolBalls());
});

test("the cue leaves with the power the page's own strike function gives it", () => {
  // The server must strike the cue exactly as the page does, or the replay
  // would be a different shot. `applyShotPower` is that one function.
  assert.ok(applyShotPower(120) > applyShotPower(60));
  assert.ok(applyShotPower(60) > applyShotPower(5));
  assert.ok(applyShotPower(120) > 0);

  // ...and a hard stroke really does keep the table moving longer than a soft
  // one: the cue is struck faster, so the roll takes more physics steps.
  const state = createInitialPoolState(1);
  const hard = simulatePoolShot(state.balls, { angle: -Math.PI / 2, pull: 120 });
  const soft = simulatePoolShot(state.balls, { angle: -Math.PI / 2, pull: 5 });
  assert.ok(hard.ticks > soft.ticks, "a harder stroke rolls longer");
});

test("a scratch is a foul: ball in hand and the turn passes", () => {
  const state = createInitialPoolState(1);
  const { state: after, result } = applyPoolShot(state, {
    angle: SCRATCH_ANGLE,
    pull: 120,
    cueX: 120,
    cueY: 120,
  });

  assert.equal(result.meta.cueScratch, true, "the cue found the pocket");
  assert.equal(after.foul, true);
  assert.equal(after.ballInHand, true);
  assert.equal(after.turn, 2, "a foul hands the table over");
  assert.equal(after.winner, null, "no winner from a foul");
  assert.equal(after.team1, null, "an open table stays open");
  assert.equal(after.team2, null);
  assert.equal(after.version, state.version + 1);
  assert.equal(after.lastShooter, 1);
});

test("a stroke that pots nothing is legal when a ball reaches a rail", () => {
  const state = createInitialPoolState(1);
  const { state: after, result } = applyPoolShot(state, {
    angle: -Math.PI / 2,
    pull: 120,
  });
  assert.equal(result.meta.pocketedNumbers.length, 0);
  if (result.meta.firstContactNumber !== null) {
    // A legal safety: contact plus a rail is not a foul.
    assert.equal(after.ballInHand, false);
    assert.equal(after.turn, 2, "no pot, no keep-turn");
  }
});

// ════════════════════════════════════════════════════════════════════════
// 3. The routes: server-authoritative, escrowed, 10% rake
// ════════════════════════════════════════════════════════════════════════

test("a shot is applied by the server, on the shooter's turn, in a locked transaction", () => {
  const src = read("src/app/api/pool/submit-shot/route.ts");
  assert.match(src, /applyPoolShot\(/, "the server replays the stroke");
  assert.match(src, /poolSeatFor\(/, "the caller must hold a seat");
  assert.match(src, /not_your_turn/, "only the seat on turn may shoot");
  assert.match(src, /\.for\("update"\)/, "the row is locked for the stroke");
  assert.match(src, /lastShotId === shotId/, "a retried stroke is not a second stroke");
  assert.doesNotMatch(src, /body\.winner/, "the request cannot name a winner");
});

test("a retried stroke is idempotent and a finished match stays final", () => {
  const src = read("src/app/api/pool/submit-shot/route.ts");
  assert.match(src, /replay: true/, "a duplicate submission replays the answer");
  assert.match(src, /match_finished/, "a settled match refuses new strokes");
});

test("live sync cannot declare a winner", () => {
  const src = read("src/app/api/pool/update-state/route.ts");
  assert.match(src, /winner: serverState\?\.winner \?\? null/);
  assert.match(src, /match\.status === "finished"/);
  assert.doesNotMatch(src, /winner: state\.winner/);
});

test("the winner is paid the pot at the shared 10% rake", () => {
  assert.equal(pvpPotPayout(10), 18);
  assert.equal(pvpPotPayout(100), 180);

  const src = read("src/app/api/pool/submit-shot/route.ts");
  assert.match(src, /payPvpPot\(\{/, "the pot is paid from escrow");
  assert.match(src, /gameKey: "pool"/);
  // A free / vs-AI match has no pot to move.
  assert.match(src, /wager\) > 0/);
});

test("both seats are escrowed when the lobby becomes a match", () => {
  const src = read("src/lib/pool/lobbyJoin.ts");
  assert.match(src, /escrowMatchWagers\(\{/);
  assert.match(src, /gameKey: "pool"/);
  assert.match(src, /clerkIds: \[claimedLobby\.hostUserId, opponentUserId\]/);
  // A refusal rolls the claim back rather than seating an unfunded match.
  assert.match(src, /_httpStatus/);

  const create = read("src/app/api/pool/create-lobby/route.ts");
  assert.match(create, /requireStake\(wager, "pool"\)/);
});

test("a private room is still free-only, and says so", () => {
  const src = read("src/lib/pool/lobbyJoin.ts");
  assert.match(src, /private rooms are free-play only/i);
});
