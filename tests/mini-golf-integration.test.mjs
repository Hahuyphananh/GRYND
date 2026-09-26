/**
 * Mini Golf — authoritative gameplay flow integration tests.
 *
 * These exercise the SAME pipeline the API route runs, minus SQL:
 *
 *   participant check → status check → validateShot → simulateShot → applyShot
 *   → (anti-replay shot log) → status/phase update → viewer projection
 *
 * The default simulator is the real deterministic physics module, so the
 * "valid shot" / "invalid shot" / "duplicate" paths are genuinely integrated
 * across physics + rules. The hole/match progression tests inject a
 * plan-driven simulation output (the same seam the store has between
 * `simulateShot` and `applyShot`) so hole winners can be pinned exactly.
 *
 * Run:  node --import tsx --test tests/mini-golf-integration.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  applyShot,
  createInitialState,
  holeFor,
  normalizeForViewer,
  seatForUser,
  statusForState,
  validateShot,
  LIFECYCLE_STAGES,
} from "../src/lib/mini-golf/rules.ts";
import { MATCH_STATUS } from "../src/lib/mini-golf/constants.ts";
import { simulateShot } from "../src/lib/mini-golf/physics.ts";

const P1 = "user_a";
const P2 = "user_b";

function seatsFromRow(row) {
  return { player1Id: row.player1Id, player2Id: row.player2Id ?? null };
}

/** A ShotResult stub — the rules engine only reads the summary fields. */
function stubShot(overrides = {}) {
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

/**
 * A tiny in-memory stand-in for `serverStore.shoot`, honouring the exact
 * ordering and guards the real store applies inside its row-locked
 * transaction. `simulate(args, ctx)` returns the authoritative ShotResult.
 */
function createServer({ seed, status = MATCH_STATUS.PLAYING, simulate = simulateShot }) {
  let row = {
    id: "11111111-1111-4111-8111-111111111111",
    player1Id: P1,
    player2Id: P2,
    status,
    isAi: false,
    gameState: createInitialState({ seed }),
  };
  const shots = [];

  function getState(userId) {
    const seats = seatsFromRow(row);
    if (!seatForUser(seats, userId)) {
      return { error: "Not a participant of this match", status: 403 };
    }
    return {
      match: row,
      dto: normalizeForViewer({
        state: row.gameState,
        seats,
        viewerId: userId,
        status: row.status,
      }),
    };
  }

  function shoot(userId, { angle, power, expectedVersion } = {}) {
    // Status gate (the store checks waiting/finished/cancelled + 2 seats).
    const seats = seatsFromRow(row);
    const seat = seatForUser(seats, userId);
    if (!seat) return { error: "Not a participant of this match", status: 403 };
    if (row.status === MATCH_STATUS.WAITING || !row.player2Id) {
      return { error: "Waiting for an opponent", status: 409 };
    }
    if (row.status === MATCH_STATUS.FINISHED || row.status === MATCH_STATUS.CANCELLED) {
      return { error: "Match is not active", status: 409 };
    }

    const state = row.gameState;
    const validation = validateShot({ state, seat, angle, power, expectedVersion });
    if (!validation.ok) {
      return { error: validation.error, status: validation.status };
    }

    // Authoritative simulation: geometry + starting ball come from the
    // persisted state, never from the request.
    const hole = holeFor(state);
    const from = state.balls[seat];
    const shotResult = simulate(
      { hole, from: { x: from.x, y: from.y }, shot: { angle: Number(angle), power: Number(power) } },
      { seat, state, hole },
    );

    const applied = applyShot({
      state,
      seat,
      angle: Number(angle),
      power: Number(power),
      shotResult,
    });
    const nextState = applied.state;

    // Anti-replay: a monotonic per-match sequence, uniquely enforced by the
    // (match_id, shot_seq) index in the real schema.
    if (shots.some((s) => s.shotSeq === nextState.shotSeq)) {
      return { error: "Duplicate shot", status: 409 };
    }
    shots.push({
      shotSeq: nextState.shotSeq,
      seat,
      hole: state.currentHole,
      strokeNumber: nextState.holeScores[state.currentHole - 1][seat],
      shotResult,
    });

    row = {
      ...row,
      status: applied.matchCompleted ? MATCH_STATUS.FINISHED : statusForState(nextState),
      gameState: nextState,
      winnerId: applied.matchCompleted ? userIdForWinner(seats, nextState) : row.winnerId,
    };

    return { ...applied, shotResult, match: row };
  }

  function userIdForWinner(seats, state) {
    if (state.player1HoleWins > state.player2HoleWins) return seats.player1Id;
    if (state.player2HoleWins > state.player1HoleWins) return seats.player2Id;
    return null;
  }

  return { getState, shoot, shots, snapshot: () => row };
}

/** Pockets for `seat` on `hole` once it has taken `strokes` total strokes. */
function planSimulator(planByHole) {
  return (_args, { seat, state }) => {
    const take = planByHole[state.currentHole]?.[seat] ?? 1;
    const taken = state.holeScores[state.currentHole - 1][seat] + 1;
    const pocketed = taken >= take;
    return stubShot({
      pocketed,
      restPosition: pocketed
        ? { x: holeFor(state).geometry.cup.x, y: holeFor(state).geometry.cup.y }
        : { x: 4, y: 5 },
    });
  };
}

// ── Valid shot ────────────────────────────────────────────────────────────

test("a valid shot runs the full server pipeline and is authoritative", () => {
  const server = createServer({ seed: 2026 });
  const before = server.getState(P1).dto;
  assert.equal(before.currentTurn, "player1");

  const result = server.shoot(P1, { angle: 90, power: 40, expectedVersion: before.version });
  assert.ok(!result.error, result.error);

  // The simulation is real physics: a deterministic path + final ball state.
  assert.ok(Array.isArray(result.shotResult.path));
  assert.ok(result.shotResult.path.length > 0);
  assert.equal(result.shotResult.settled, true);
  assert.equal(result.state.version, before.version + 1);
  assert.equal(result.state.shotSeq, 1);
  assert.equal(result.state.holeScores[0].player1, 1);
  assert.equal(result.match.status, MATCH_STATUS.PLAYING);

  // Lifecycle: every shot opens SHOT_RESOLVING → BALL_SETTLED.
  assert.deepEqual(result.stages, ["SHOT_RESOLVING", "BALL_SETTLED", "NEXT_PLAYER_TURN"]);

  // The ball position is the server's rest position, not anything a client sent.
  const p1Ball = result.state.balls.player1;
  assert.equal(p1Ball.x, result.shotResult.restPosition.x);
  assert.equal(p1Ball.y, result.shotResult.restPosition.y);
});

test("client-supplied result fields are ignored entirely", () => {
  const clean = createServer({ seed: 7 });
  const hostile = createServer({ seed: 7 });

  const a = clean.shoot(P1, { angle: 90, power: 40, expectedVersion: 1 });
  const b = hostile.shoot(P1, {
    angle: 90,
    power: 40,
    expectedVersion: 1,
    // Everything a cheating client would love to control.
    restPosition: { x: 999, y: 999 },
    pocketed: true,
    strokeNumber: 0,
    holeWinner: "player1",
    winner: "player1",
    ratingChange: 500,
    holeResult: "player1",
  });

  assert.equal(JSON.stringify(a.state), JSON.stringify(b.state));
  assert.equal(b.state.holeScores[0].player1, 1);
  assert.notEqual(b.state.balls.player1.x, 999);
});

// ── Wrong player / invalid input ──────────────────────────────────────────

test("a shot from the wrong player is rejected", () => {
  const server = createServer({ seed: 1 });
  const result = server.shoot(P2, { angle: 90, power: 40, expectedVersion: 1 });
  assert.equal(result.status, 409);
  assert.match(result.error, /turn/i);
  assert.equal(server.snapshot().gameState.holeScores[0].player2, 0);
});

test("a non-participant cannot shoot or read the match", () => {
  const server = createServer({ seed: 1 });
  assert.equal(server.shoot("stranger", { angle: 90, power: 40 }).status, 403);
  assert.equal(server.getState("stranger").status, 403);
});

test("invalid angle/power submissions are rejected before any simulation", () => {
  const server = createServer({ seed: 1 });
  const bad = [
    { angle: 360, power: 10 },
    { angle: -1, power: 10 },
    { angle: 0, power: 101 },
    { angle: NaN, power: 10 },
    { angle: 0, power: "50" },
    { angle: 0, power: null },
  ];
  for (const body of bad) {
    const result = server.shoot(P1, { ...body, expectedVersion: 1 });
    assert.equal(result.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
  // Nothing was applied.
  assert.equal(server.snapshot().gameState.shotSeq, 0);
  assert.equal(server.shots.length, 0);
});

// ── Duplicate / replayed shots ────────────────────────────────────────────

test("a replayed shot is rejected by the version guard and never double-counts", () => {
  const server = createServer({ seed: 1 });
  const request = { angle: 90, power: 40, expectedVersion: 1 };

  const first = server.shoot(P1, request);
  assert.equal(first.error, undefined);
  assert.equal(first.state.holeScores[0].player1, 1);
  assert.equal(first.state.version, 2);
  assert.equal(first.state.currentTurn, "player2");

  // The exact same request replayed: the turn has moved on, so it is rejected
  // and — critically — never counted a second time.
  const replay = server.shoot(P1, request);
  assert.equal(replay.status, 409);
  assert.equal(server.snapshot().gameState.holeScores[0].player1, 1);
  assert.equal(server.snapshot().gameState.shotSeq, 1);
  assert.equal(server.shots.length, 1);

  // A stale tab acting on the pre-shot snapshot is rejected by the optimistic
  // concurrency guard…
  const stale = server.shoot(P2, { angle: 90, power: 40, expectedVersion: 1 });
  assert.equal(stale.status, 409);
  assert.match(stale.error, /stale/i);
  assert.equal(server.snapshot().gameState.holeScores[0].player2, 0);

  // …while the current version is accepted exactly once.
  const fresh = server.shoot(P2, { angle: 90, power: 40, expectedVersion: 2 });
  assert.equal(fresh.error, undefined);
  assert.equal(fresh.state.holeScores[0].player2, 1);
  assert.equal(server.snapshot().gameState.shotSeq, 2);
  assert.equal(server.shots.length, 2);
});

// ── Hole completion & scoring ─────────────────────────────────────────────

test("a hole completes only when both seats hole out, then advances", () => {
  const server = createServer({ seed: 3, simulate: planSimulator({ 1: { player1: 1, player2: 2 } }) });

  let r = server.shoot(P1, { angle: 0, power: 10, expectedVersion: 1 });
  assert.equal(r.holeCompleted, false, "one seat holed out is not a completed hole");
  assert.deepEqual(r.stages, ["SHOT_RESOLVING", "BALL_SETTLED", "NEXT_PLAYER_TURN"]);

  r = server.shoot(P2, { angle: 0, power: 10, expectedVersion: 2 });
  r = server.shoot(P2, { angle: 0, power: 10, expectedVersion: 3 });

  assert.equal(r.holeCompleted, true);
  assert.equal(r.holeWinner, "player1");
  assert.deepEqual(r.stages, ["SHOT_RESOLVING", "BALL_SETTLED", "HOLE_COMPLETED", "NEXT_HOLE"]);
  assert.equal(r.state.currentHole, 2);
  assert.equal(r.state.player1HoleWins, 1);
  assert.equal(r.state.holeWinners[0], "player1");
  assert.equal(r.state.currentTurn, "player2", "hole 2 is started by player2");
});

test("a tied hole awards nobody", () => {
  const server = createServer({ seed: 3, simulate: planSimulator({ 1: { player1: 1, player2: 1 } }) });

  server.shoot(P1, { angle: 0, power: 10, expectedVersion: 1 });
  const r = server.shoot(P2, { angle: 0, power: 10, expectedVersion: 2 });

  assert.equal(r.holeCompleted, true);
  assert.equal(r.holeWinner, "tie");
  assert.equal(r.state.player1HoleWins, 0);
  assert.equal(r.state.player2HoleWins, 0);
  assert.equal(r.state.holeWinners[0], "tie");
  assert.equal(r.match.status, MATCH_STATUS.PLAYING);
});

// ── Match completion ──────────────────────────────────────────────────────

test("first to 3 hole wins ends the match immediately, not after five holes", () => {
  const server = createServer({
    seed: 11,
    simulate: planSimulator({
      1: { player1: 1, player2: 2 },
      2: { player1: 1, player2: 2 },
      3: { player1: 1, player2: 2 },
    }),
  });

  let version = 1;
  let last = null;
  for (let hole = 0; hole < 3; hole += 1) {
    let done = false;
    while (!done) {
      const seat = server.snapshot().gameState.currentTurn;
      const r = server.shoot(seat === "player1" ? P1 : P2, {
        angle: 0,
        power: 10,
        expectedVersion: version,
      });
      version = r.state.version;
      last = r;
      done = r.holeCompleted;
    }
  }

  assert.equal(last.matchCompleted, true);
  assert.deepEqual(last.stages, [
    "SHOT_RESOLVING",
    "BALL_SETTLED",
    "HOLE_COMPLETED",
    "MATCH_COMPLETED",
  ]);
  assert.equal(server.snapshot().status, MATCH_STATUS.FINISHED);
  assert.equal(server.snapshot().gameState.phase, "finished");
  assert.equal(server.snapshot().gameState.player1HoleWins, 3);
  assert.equal(server.snapshot().gameState.currentHole, 3, "the match ends on the winning hole");
  assert.equal(server.snapshot().winnerId, P1);
});

test("a player cannot shoot after the match is complete", () => {
  const server = createServer({
    seed: 11,
    simulate: planSimulator({
      1: { player1: 1, player2: 2 },
      2: { player1: 1, player2: 2 },
      3: { player1: 1, player2: 2 },
    }),
  });

  let version = 1;
  outer: for (let hole = 0; hole < 4; hole += 1) {
    while (true) {
      const seat = server.snapshot().gameState.currentTurn;
      const r = server.shoot(seat === "player1" ? P1 : P2, {
        angle: 0,
        power: 10,
        expectedVersion: version,
      });
      version = r.state.version;
      if (r.matchCompleted) break outer;
    }
  }

  const after = server.shoot(P1, { angle: 0, power: 10, expectedVersion: version });
  assert.equal(after.status, 409);
  assert.match(after.error, /not active/i);
});

// ── Reconnect / state synchronisation ─────────────────────────────────────

test("both seats resynchronise to the identical authoritative snapshot", () => {
  const server = createServer({ seed: 42 });

  server.shoot(P1, { angle: 90, power: 40, expectedVersion: 1 });

  // A reconnecting client just re-fetches the match snapshot.
  const p1 = server.getState(P1).dto;
  const p2 = server.getState(P2).dto;

  // Both views agree on every authoritative field…
  for (const key of [
    "version",
    "phase",
    "status",
    "seed",
    "currentHole",
    "currentTurn",
    "holeScores",
    "holeWinners",
    "player1HoleWins",
    "player2HoleWins",
    "shotSeq",
    "balls",
  ]) {
    assert.deepEqual(p1[key], p2[key], `view mismatch on ${key}`);
  }

  // …and differ only in the per-viewer flags.
  assert.equal(p1.currentTurn, "player2");
  assert.equal(p2.viewerSeat, "player2");
  assert.equal(p2.viewerCanShoot, true);
  assert.equal(p1.viewerCanShoot, false, "a stale seat is never offered a shot");

  // The refreshed client can act immediately on the current version.
  const latest = server.getState(P2).dto;
  const r = server.shoot(P2, { angle: 90, power: 40, expectedVersion: latest.version });
  assert.equal(r.error, undefined);
  assert.equal(r.state.shotSeq, 2);
});

test("the lifecycle vocabulary is complete and ordered", () => {
  assert.deepEqual([...LIFECYCLE_STAGES], [
    "SHOT_RESOLVING",
    "BALL_SETTLED",
    "HOLE_COMPLETED",
    "NEXT_PLAYER_TURN",
    "NEXT_HOLE",
    "MATCH_COMPLETED",
  ]);
});
