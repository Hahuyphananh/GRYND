/**
 * Mini Golf — rules engine tests.
 *
 * The rules engine is the authoritative game logic: it decides whose turn it
 * is, when a hole is complete, who won it, and who won the match. It is pure
 * (no DB, no IO, no randomness), so every lifecycle edge can be pinned here.
 *
 * These tests also assert the anti-cheat property directly: stroke counts,
 * hole completion, hole winners and the match winner are all derived from the
 * server's shot result, never from anything a client could put on the object.
 *
 * Run:  node --import tsx --test tests/mini-golf-rules.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  applyShot,
  computeMatchResult,
  createInitialState,
  decideHoleWinner,
  holeFor,
  isMatchComplete,
  normalizeForViewer,
  otherSeat,
  seatForUser,
  starterSeatForHole,
  statusForState,
  userIdForSeat,
  validateShot,
} from "../src/lib/mini-golf/rules.ts";
import { HOLES_TO_WIN, HOLE_COUNT, MATCH_STATUS } from "../src/lib/mini-golf/constants.ts";

const SEATS = { player1Id: "user_a", player2Id: "user_b" };

/** A ShotResult stub — the rules engine only reads the summary fields. */
function shot(overrides = {}) {
  return {
    path: [],
    restPosition: { x: 5, y: 6 },
    pocketed: false,
    settled: true,
    frames: 1,
    substeps: 1,
    hitStepLimit: false,
    waterHits: 0,
    ...overrides,
  };
}

function step(state, seat, overrides = {}) {
  return applyShot({
    state,
    seat,
    angle: 0,
    power: 10,
    shotResult: shot(overrides),
  });
}

/**
 * Play the current hole to completion in real turn order, giving each seat the
 * requested stroke count (the last stroke holes out).
 */
function playHole(state, strokesBySeat) {
  let s = state;
  const taken = { player1: 0, player2: 0 };
  for (let i = 0; i < 40; i += 1) {
    const seat = s.currentTurn;
    taken[seat] += 1;
    const result = step(s, seat, { pocketed: taken[seat] >= strokesBySeat[seat] });
    s = result.state;
    if (result.holeCompleted || result.matchCompleted) return { state: s, applied: result };
  }
  throw new Error("hole did not complete within 40 strokes");
}

// ── Construction ──────────────────────────────────────────────────────────

test("createInitialState builds a five-hole match in the aiming phase", () => {
  const s = createInitialState({ seed: 7 });
  assert.equal(s.version, 1);
  assert.equal(s.phase, "aiming");
  assert.equal(s.seed, 7);
  assert.equal(s.holes.length, HOLE_COUNT);
  assert.equal(s.currentHole, 1);
  assert.equal(s.currentTurn, "player1");
  assert.equal(s.shotSeq, 0);
  assert.equal(s.player1HoleWins, 0);
  assert.equal(s.player2HoleWins, 0);
  assert.deepEqual(s.holeScores, Array.from({ length: HOLE_COUNT }, () => ({ player1: 0, player2: 0 })));
  assert.deepEqual(s.holeWinners, Array.from({ length: HOLE_COUNT }, () => null));
  assert.equal(s.lastShot, null);

  // Both balls start on the hole's tee, and the mirror points at the active ball.
  const tee = holeFor(s).geometry.tee;
  for (const seat of ["player1", "player2"]) {
    assert.equal(s.balls[seat].x, tee.x);
    assert.equal(s.balls[seat].y, tee.y);
    assert.equal(s.balls[seat].holedOut, false);
  }
  assert.deepEqual(s.currentBall, { x: tee.x, y: tee.y });
});

test("createInitialState rejects a non-finite seed", () => {
  assert.throws(() => createInitialState({ seed: NaN }), TypeError);
});

test("the hole starter alternates by hole parity", () => {
  assert.equal(starterSeatForHole(1), "player1");
  assert.equal(starterSeatForHole(2), "player2");
  assert.equal(starterSeatForHole(3), "player1");
  assert.equal(starterSeatForHole(4), "player2");
  assert.equal(starterSeatForHole(5), "player1");
});

test("seat helpers map users and mirror each other", () => {
  assert.equal(seatForUser(SEATS, "user_a"), "player1");
  assert.equal(seatForUser(SEATS, "user_b"), "player2");
  assert.equal(seatForUser(SEATS, "stranger"), null);
  assert.equal(seatForUser({ player1Id: "user_a", player2Id: null }, "user_a"), "player1");
  assert.equal(otherSeat("player1"), "player2");
  assert.equal(userIdForSeat(SEATS, "player2"), "user_b");
});

// ── Validation (the security surface) ─────────────────────────────────────

test("validateShot accepts a legal turn", () => {
  const s = createInitialState({ seed: 1 });
  const v = validateShot({ state: s, seat: "player1", angle: 90, power: 50, expectedVersion: 1 });
  assert.equal(v.ok, true);
  assert.equal(v.seat, "player1");
});

test("validateShot rejects a non-participant", () => {
  const s = createInitialState({ seed: 1 });
  const v = validateShot({ state: s, seat: null, angle: 0, power: 10 });
  assert.equal(v.ok, false);
  assert.equal(v.status, 403);
});

test("validateShot rejects an out-of-turn shot", () => {
  const s = createInitialState({ seed: 1 });
  const v = validateShot({ state: s, seat: "player2", angle: 0, power: 10 });
  assert.equal(v.ok, false);
  assert.equal(v.status, 409);
  assert.match(v.error, /turn/i);
});

test("validateShot rejects a finished or resolving match", () => {
  const base = createInitialState({ seed: 1 });
  const finished = { ...base, phase: "finished" };
  const resolving = { ...base, phase: "resolving" };
  assert.equal(validateShot({ state: finished, seat: "player1", angle: 0, power: 10 }).status, 409);
  assert.equal(validateShot({ state: resolving, seat: "player1", angle: 0, power: 10 }).status, 409);
});

test("validateShot rejects a seat that already holed out", () => {
  const s = createInitialState({ seed: 1 });
  const holed = { ...s, balls: { ...s.balls, player1: { ...s.balls.player1, holedOut: true } } };
  const v = validateShot({ state: holed, seat: "player1", angle: 0, power: 10 });
  assert.equal(v.ok, false);
  assert.equal(v.status, 409);
  assert.match(v.error, /completed this hole/i);
});

test("validateShot rejects a stale expectedVersion", () => {
  const s = createInitialState({ seed: 1 });
  assert.equal(validateShot({ state: s, seat: "player1", angle: 0, power: 10, expectedVersion: 0 }).status, 409);
  assert.equal(validateShot({ state: s, seat: "player1", angle: 0, power: 10, expectedVersion: "2" }).status, 409);
  assert.equal(validateShot({ state: s, seat: "player1", angle: 0, power: 10, expectedVersion: 1 }).ok, true);
  // Omitting it is allowed — the turn/holed-out checks still hold.
  assert.equal(validateShot({ state: s, seat: "player1", angle: 0, power: 10 }).ok, true);
});

test("validateShot rejects malformed angles and powers", () => {
  const s = createInitialState({ seed: 1 });
  const bad = [
    { angle: NaN, power: 10 },
    { angle: 0, power: NaN },
    { angle: Infinity, power: 10 },
    { angle: 0, power: "50" },
    { angle: 360, power: 10 },
    { angle: -1, power: 10 },
    { angle: 0, power: 101 },
    { angle: 0, power: -1 },
    { angle: 0, power: undefined },
  ];
  for (const body of bad) {
    const v = validateShot({ state: s, seat: "player1", ...body });
    assert.equal(v.ok, false, `expected rejection for ${JSON.stringify(body)}`);
    assert.equal(v.status, 400);
  }
});

// ── Shot application ──────────────────────────────────────────────────────

test("a shot bumps the version, the shot sequence and the stroke count", () => {
  const s = createInitialState({ seed: 1 });
  const r = step(s, "player1");
  assert.equal(r.state.version, s.version + 1);
  assert.equal(r.state.shotSeq, 1);
  assert.equal(r.state.holeScores[0].player1, 1);
  assert.equal(r.state.holeScores[0].player2, 0);
  assert.equal(r.state.balls.player1.x, 5);
  assert.equal(r.state.balls.player1.y, 6);
  assert.equal(r.holeCompleted, false);
  assert.equal(r.matchCompleted, false);
  assert.equal(r.state.lastShot.seat, "player1");
  assert.equal(r.state.lastShot.hole, 1);
  assert.equal(r.state.lastShot.strokeNumber, 1);
});

test("client-supplied stroke and winner fields are ignored", () => {
  const s = createInitialState({ seed: 1 });
  let cur = s;
  for (let i = 0; i < 2; i += 1) {
    // Smuggle in the fields a cheating client would love to control.
    cur = step(cur, cur.currentTurn, {
      pocketed: false,
      strokes: 0,
      winner: "player2",
      winnerId: "user_b",
      holedOut: true,
    }).state;
  }
  assert.equal(cur.holeScores[0].player1, 1);
  assert.equal(cur.holeScores[0].player2, 1);
  assert.equal(cur.holeWinners[0], null);
  assert.equal(cur.player1HoleWins, 0);
  assert.equal(cur.player2HoleWins, 0);
  assert.equal(cur.balls.player1.holedOut, false);
});

test("the turn alternates and a holed-out seat cannot play again", () => {
  const s = createInitialState({ seed: 1 });
  let r = step(s, "player1", { pocketed: true });
  assert.equal(r.state.currentTurn, "player2");

  r = step(r.state, "player2");
  assert.equal(r.state.currentTurn, "player2", "the finished seat keeps the turn");

  r = step(r.state, "player2", { pocketed: true });
  assert.equal(r.holeCompleted, true);
});

test("water adds a one-stroke penalty on top of the shot", () => {
  const s = createInitialState({ seed: 1 });
  const r = step(s, "player1", { waterHits: 1 });
  assert.equal(r.state.holeScores[0].player1, 2);
});

test("a hole completes only when BOTH seats have holed out", () => {
  const s = createInitialState({ seed: 1 });
  let r = step(s, "player1", { pocketed: true });
  assert.equal(r.holeCompleted, false, "one seat holed out is not a completed hole");
  r = step(r.state, "player2", { pocketed: true });
  assert.equal(r.holeCompleted, true);
});

test("the hole is won by the lower stroke count, and a tie awards nobody", () => {
  const base = createInitialState({ seed: 3 });

  // player1 wins 1 stroke to 2
  const win = playHole(base, { player1: 1, player2: 2 });
  assert.equal(win.applied.holeWinner, "player1");
  assert.equal(win.state.player1HoleWins, 1);
  assert.equal(win.state.player2HoleWins, 0);

  // a 1-1 tie on the next hole awards neither seat
  const tied = playHole(win.state, { player1: 1, player2: 1 });
  assert.equal(tied.applied.holeWinner, "tie");
  assert.equal(tied.state.player1HoleWins, 1);
  assert.equal(tied.state.player2HoleWins, 0);
  assert.equal(tied.state.holeWinners[1], "tie");
});

test("the next hole resets both balls to its tee and alternates the starter", () => {
  const base = createInitialState({ seed: 3 });
  const { state } = playHole(base, { player1: 1, player2: 1 });
  assert.equal(state.currentHole, 2);
  assert.equal(state.currentTurn, "player2", "hole 2 is started by player2");
  const tee2 = state.holes[1].geometry.tee;
  assert.deepEqual(state.balls.player1, { x: tee2.x, y: tee2.y, holedOut: false });
  assert.deepEqual(state.balls.player2, { x: tee2.x, y: tee2.y, holedOut: false });
  // `lastShot` survives the transition on purpose: it carries the
  // hole-completing trajectory (and its own hole number) so the OPPONENT — who
  // only ever sees the snapshot — can animate the same shot the shooter saw in
  // the /shoot response. The next shot overwrites it.
  assert.ok(state.lastShot, "the hole-completing shot is retained for both seats");
  assert.equal(state.lastShot.hole, 1);
});

test("the retained lastShot lets a client replay the hole-completing shot", () => {
  const base = createInitialState({ seed: 3 });
  const played = playHole(base, { player1: 1, player2: 1 });

  // The match advanced to hole 2, but the shot that finished hole 1 is intact.
  assert.equal(played.state.currentHole, 2);
  assert.equal(played.state.lastShot.hole, 1);
  // Both seats hole out in 1 stroke, so player2 (who shoots second) took the
  // final stroke of the hole.
  assert.equal(played.state.lastShot.seat, "player2");
  assert.ok(Array.isArray(played.state.lastShot.result.path));

  // A fresh match never has one.
  assert.equal(createInitialState({ seed: 3 }).lastShot, null);
});

test("normalizeForViewer exposes the settled outcome without a client claim", () => {
  const s = createInitialState({ seed: 1 });
  const dto = normalizeForViewer({
    state: s,
    seats: SEATS,
    viewerId: "user_a",
    status: MATCH_STATUS.FINISHED,
    result: "player2",
    winnerId: "user_b",
  });
  assert.equal(dto.result, "player2");
  assert.equal(dto.winnerId, "user_b");

  // Unsettled matches report nulls rather than guessing from hole wins.
  const live = normalizeForViewer({ state: s, seats: SEATS, viewerId: "user_a" });
  assert.equal(live.result, null);
  assert.equal(live.winnerId, null);
});

test("decideHoleWinner compares strokes directly", () => {
  assert.equal(decideHoleWinner({ player1: 2, player2: 3 }), "player1");
  assert.equal(decideHoleWinner({ player1: 4, player2: 3 }), "player2");
  assert.equal(decideHoleWinner({ player1: 3, player2: 3 }), "tie");
});

// ── Match completion ──────────────────────────────────────────────────────

test("first to 3 holes wins the match immediately", () => {
  let cur = createInitialState({ seed: 11 });
  assert.equal(HOLES_TO_WIN, 3);

  let last = null;
  for (let hole = 0; hole < 3; hole += 1) {
    const played = playHole(cur, { player1: 1, player2: 2 });
    cur = played.state;
    last = played.applied;
  }

  assert.equal(last.matchCompleted, true);
  assert.equal(cur.phase, "finished");
  assert.equal(cur.player1HoleWins, 3);
  assert.equal(cur.currentHole, 3, "the match ends on the winning hole, not hole 5");
  assert.equal(cur.holeWinners[3], null);
  assert.equal(cur.holeWinners[4], null);
  assert.equal(statusForState(cur), MATCH_STATUS.FINISHED);
  assert.deepEqual(computeMatchResult(cur), { result: "player1", winnerSeat: "player1" });
});

test("five tied holes produce a 0-0 draw with no winner", () => {
  let cur = createInitialState({ seed: 21 });
  let last = null;
  for (let hole = 0; hole < HOLE_COUNT; hole += 1) {
    const played = playHole(cur, { player1: 1, player2: 1 });
    cur = played.state;
    last = played.applied;
  }
  assert.equal(last.matchCompleted, true);
  assert.equal(cur.phase, "finished");
  assert.equal(cur.player1HoleWins, 0);
  assert.equal(cur.player2HoleWins, 0);
  assert.equal(isMatchComplete(cur), true);
  assert.deepEqual(computeMatchResult(cur), { result: "tie", winnerSeat: null });
  assert.equal(statusForState(cur), MATCH_STATUS.FINISHED);
});

test("a 2-2 split after five holes is a draw", () => {
  let cur = createInitialState({ seed: 31 });
  // holes 1-4 split, hole 5 tied → 2-2
  const plan = [
    { player1: 1, player2: 2 },
    { player1: 1, player2: 2 },
    { player1: 2, player2: 1 },
    { player1: 2, player2: 1 },
    { player1: 1, player2: 1 },
  ];
  for (const strokes of plan) cur = playHole(cur, strokes).state;

  assert.equal(cur.phase, "finished");
  assert.equal(cur.player1HoleWins, 2);
  assert.equal(cur.player2HoleWins, 2);
  assert.deepEqual(computeMatchResult(cur), { result: "tie", winnerSeat: null });
});

test("computeMatchResult derives the winner only from hole wins", () => {
  const base = createInitialState({ seed: 1 });
  // Injected client-ish fields must not influence the outcome.
  const tampered = { ...base, player1HoleWins: 1, player2HoleWins: 2, winnerId: "user_a", result: "player1" };
  assert.deepEqual(computeMatchResult(tampered), { result: "player2", winnerSeat: "player2" });
});

test("a finished match rejects further shots", () => {
  const base = createInitialState({ seed: 1 });
  const finished = { ...base, phase: "finished" };
  const v = validateShot({ state: finished, seat: "player1", angle: 0, power: 10 });
  assert.equal(v.ok, false);
  assert.equal(v.status, 409);
});

test("statusForState reports playing until the phase is finished", () => {
  const s = createInitialState({ seed: 1 });
  assert.equal(statusForState(s), MATCH_STATUS.PLAYING);
  assert.equal(statusForState({ ...s, phase: "finished" }), MATCH_STATUS.FINISHED);
});

// ── Viewer projection ─────────────────────────────────────────────────────

test("normalizeForViewer resolves the seat, turn and shoot permission", () => {
  const s = createInitialState({ seed: 1 });

  const p1 = normalizeForViewer({ state: s, seats: SEATS, viewerId: "user_a" });
  assert.equal(p1.viewerSeat, "player1");
  assert.equal(p1.isViewerTurn, true);
  assert.equal(p1.viewerCanShoot, true);
  assert.equal(p1.currentTurnUserId, "user_a");
  assert.equal(p1.player1Id, "user_a");
  assert.equal(p1.status, MATCH_STATUS.PLAYING);

  const p2 = normalizeForViewer({ state: s, seats: SEATS, viewerId: "user_b" });
  assert.equal(p2.viewerSeat, "player2");
  assert.equal(p2.isViewerTurn, false);
  assert.equal(p2.viewerCanShoot, false);
});

test("normalizeForViewer denies shooting out of turn, after holing out, and when finished", () => {
  const s = createInitialState({ seed: 1 });

  const afterP1 = step(s, "player1", { pocketed: true }).state;
  const p1 = normalizeForViewer({ state: afterP1, seats: SEATS, viewerId: "user_a" });
  assert.equal(p1.viewerHasHoledOut, true);
  assert.equal(p1.viewerCanShoot, false, "a holed-out seat cannot shoot");
  const p2 = normalizeForViewer({ state: afterP1, seats: SEATS, viewerId: "user_b" });
  assert.equal(p2.viewerCanShoot, true, "the remaining seat can shoot");

  const finished = normalizeForViewer({
    state: { ...s, phase: "finished" },
    seats: SEATS,
    viewerId: "user_a",
  });
  assert.equal(finished.viewerCanShoot, false);
});

test("normalizeForViewer honours an explicit row status", () => {
  const s = createInitialState({ seed: 1 });
  const dto = normalizeForViewer({
    state: s,
    seats: SEATS,
    viewerId: "user_a",
    status: MATCH_STATUS.CANCELLED,
  });
  assert.equal(dto.status, MATCH_STATUS.CANCELLED);
});

test("normalizeForViewer never exposes a shooter for a non-participant", () => {
  const s = createInitialState({ seed: 1 });
  const dto = normalizeForViewer({ state: s, seats: SEATS, viewerId: "stranger" });
  assert.equal(dto.viewerSeat, null);
  assert.equal(dto.viewerCanShoot, false);
});
