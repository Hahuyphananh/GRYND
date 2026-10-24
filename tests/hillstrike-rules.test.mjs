/**
 * hillstrike-rules.test.mjs
 *
 * The PURE rules engine: match creation, battlefield fairness, the opening-shot
 * and two-shot volley state machine, lives, immediate termination, rejection of
 * invalid or out-of-turn shots, immutability and determinism.
 *
 * Everything asserted here goes through the engine's published API only:
 * `createInitialState`, `validateShot`, `applyShot`, `tryApplyShot`. Physics is
 * exercised as a black box — the suite FINDS a legal firing solution instead of
 * hard-coding a tuning-dependent angle, so a balance change does not break the
 * rules tests.
 *
 * Run:  node --import tsx --test tests/hillstrike-rules.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

const {
  createInitialState,
  validateShot,
  applyShot,
  tryApplyShot,
  isHillstrikeRuleError,
  isMatchFinished,
  otherSeat,
} = await import("../src/lib/hillstrike/rules.ts");
const { simulateShot } = await import("../src/lib/hillstrike/physics.ts");
const {
  createBattlefield,
  openingSeatFor,
  validateBattlefield,
  surfaceYAt,
} = await import("../src/lib/hillstrike/generation.ts");
const { FIELD_VERSION, LIVES_PER_PLAYER, OPENING_SHOTS, SHOTS_PER_VOLLEY } =
  await import("../src/lib/hillstrike/constants.ts");

const SEED = 12345;

/** A shot that cannot hit anybody: straight up, minimum power. */
const SAFE_SHOT = Object.freeze({ angleDeg: 90, power: 0 });

/**
 * A shot that leaves the battlefield without touching anything, so the turn can
 * advance without changing the terrain (used when the next seat's firing
 * solution must be searched on the untouched battlefield).
 */
const PASS_SHOT = Object.freeze({
  player1: Object.freeze({ angleDeg: 170, power: 100 }),
  player2: Object.freeze({ angleDeg: 10, power: 100 }),
});

/** Search for a shot that directly hits the defender. Runs the real physics. */
function findHitShot(battlefield, seat, projectile) {
  for (let angleDeg = 0; angleDeg < 180; angleDeg += 2) {
    const candidate = { angleDeg, power: 100 };
    const simulation = simulateShot({
      battlefield,
      shooterSeat: seat,
      shot: candidate,
      projectile,
    });
    if (simulation.impact.kind === "player" && simulation.impact.target === otherSeat(seat)) {
      return candidate;
    }
  }
  return null;
}

/** A hit shot from whichever seat opens the given state. */
function openingHit(state) {
  const shot = findHitShot(state.battlefield, state.openingSeat, state.projectile);
  assert.ok(shot, "the engine must expose at least one legal direct hit");
  return shot;
}

const clone = (value) => JSON.parse(JSON.stringify(value));

test("a new match has the agreed shape", () => {
  const state = createInitialState({ seed: SEED });

  assert.equal(state.status, "playing");
  assert.equal(state.fieldVersion, FIELD_VERSION);
  assert.equal(state.seed, SEED);
  assert.equal(state.lives.player1, LIVES_PER_PLAYER);
  assert.equal(state.lives.player2, LIVES_PER_PLAYER);
  assert.equal(state.turn, state.openingSeat);
  assert.equal(state.turnIndex, 0);
  assert.equal(state.shotsRemaining, OPENING_SHOTS);
  assert.equal(state.openingShotPending, true);
  assert.equal(state.winner, null);
  assert.equal(state.terminationReason, null);
  assert.equal(state.lastShot, null);

  assert.deepEqual(validateBattlefield(state.battlefield), { ok: true });
  assert.equal(state.battlefield.blocks.length > 0, true);
  assert.equal(Object.isFrozen(state), true, "state is deeply frozen");
  assert.equal(Object.isFrozen(state.battlefield.terrain), true);
  assert.equal(Object.isFrozen(state.lives), true);
});

test("the battlefield is reproducible from its seed", () => {
  const first = createBattlefield(SEED);
  const second = createBattlefield(SEED);
  const other = createBattlefield(SEED + 1);

  assert.deepEqual(first, second);
  assert.notDeepEqual(first.terrain, other.terrain);
  assert.equal(first.version, FIELD_VERSION);
  assert.equal(first.seed, SEED);
});

test("the battlefield is mirror-symmetric, so neither seat has better ground", () => {
  const field = createBattlefield(SEED);
  const last = field.terrain.length - 1;

  for (let column = 0; column <= last; column++) {
    assert.equal(
      field.terrain[column],
      field.terrain[last - column],
      `column ${column} must mirror column ${last - column}`,
    );
  }

  assert.equal(field.players.player1.y, surfaceYAt(field.terrain, field.players.player1.x));
  assert.equal(field.players.player2.y, surfaceYAt(field.terrain, field.players.player2.x));
  assert.equal(
    field.players.player1.y,
    field.players.player2.y,
    "both launchers stand at the same height",
  );
});

test("the opening seat is drawn from the seed and recorded", () => {
  const state = createInitialState({ seed: SEED });
  assert.equal(state.openingSeat, openingSeatFor(SEED));
  assert.equal(createInitialState({ seed: SEED }).openingSeat, state.openingSeat);

  // Across a handful of seeds the draw must actually produce both seats.
  const seats = new Set();
  for (let seed = 0; seed < 24; seed++) seats.add(openingSeatFor(seed));
  assert.deepEqual([...seats].sort(), ["player1", "player2"]);
});

test("the opening seat can be overridden for a scripted board", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });
  assert.equal(state.openingSeat, "player1");
  assert.equal(state.turn, "player1");
  assert.equal(state.shotsRemaining, 1);

  assert.throws(
    () => createInitialState({ seed: SEED, openingSeat: "player3" }),
    /invalid opening seat/,
  );
});

test("only a valid 32-bit seed can create a match", () => {
  for (const seed of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined, "1"]) {
    assert.throws(() => createInitialState({ seed }), /seed/);
  }
});

test("the opening shot is a one-shot volley, then the seats alternate two", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });

  const afterOpening = applyShot(state, "player1", SAFE_SHOT).state;
  assert.equal(afterOpening.turn, "player2");
  assert.equal(afterOpening.shotsRemaining, SHOTS_PER_VOLLEY);
  assert.equal(afterOpening.openingShotPending, false);
  assert.equal(afterOpening.turnIndex, 1);

  const afterFirstOfTwo = applyShot(afterOpening, "player2", SAFE_SHOT).state;
  assert.equal(afterFirstOfTwo.turn, "player2", "the volley continues");
  assert.equal(afterFirstOfTwo.shotsRemaining, 1);

  const afterTwo = applyShot(afterFirstOfTwo, "player2", SAFE_SHOT).state;
  assert.equal(afterTwo.turn, "player1");
  assert.equal(afterTwo.shotsRemaining, 2);
  assert.equal(afterTwo.turnIndex, 3);

  const afterNext = applyShot(afterTwo, "player1", SAFE_SHOT).state;
  assert.equal(afterNext.turn, "player1", "two-shot volleys from here on");
  assert.equal(afterNext.shotsRemaining, 1);
});

test("a direct hit removes exactly one life, and only the victim's", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });
  const shot = openingHit(state);
  const before = clone(state);

  const { state: next, events } = applyShot(state, "player1", shot);

  assert.equal(next.lives.player2, state.lives.player2 - 1);
  assert.equal(next.lives.player1, state.lives.player1);
  assert.equal(next.turnIndex, 1);
  assert.equal(next.status, "playing");
  assert.equal(next.winner, null);
  assert.equal(next.lastShot.livesLost, 1);
  assert.equal(next.lastShot.impact.kind, "player");
  assert.equal(next.lastShot.impact.target, "player2");

  assert.deepEqual(
    next.battlefield,
    state.battlefield,
    "a player hit changes no terrain and no structure",
  );
  assert.ok(events.some((event) => event.type === "player-hit"));
  assert.equal(events.filter((event) => event.type === "life-lost").length, 1);
  assert.deepEqual(clone(state), before, "the input state is untouched");
});

test("the opening seat's volley ends after a hit, because it is only one shot", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });
  const next = applyShot(state, "player1", openingHit(state)).state;

  assert.equal(next.lives.player2, 2);
  assert.equal(next.turn, "player2");
  assert.equal(next.shotsRemaining, SHOTS_PER_VOLLEY);
});

test("a hit during a two-shot volley keeps the turn", () => {
  let state = createInitialState({ seed: SEED, openingSeat: "player1" });
  // A pass leaves the battlefield untouched, so player2's firing solution is
  // searched on exactly the terrain the match started on.
  const passed = applyShot(state, "player1", PASS_SHOT.player1).state;
  assert.equal(passed.turn, "player2");
  assert.deepEqual(passed.battlefield, state.battlefield);
  state = passed;

  const shot = findHitShot(state.battlefield, "player2", state.projectile);
  assert.ok(shot, "player2 must also have a direct firing solution");

  const next = applyShot(state, "player2", shot).state;
  assert.equal(next.lives.player1, 2);
  assert.equal(next.turn, "player2");
  assert.equal(next.shotsRemaining, 1, "the second shot of the volley remains");
});

test("structural and terrain damage never remove a life", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });

  // Find a shot that hits a structure or the ground rather than a player.
  let shot = null;
  for (let angleDeg = 0; angleDeg < 180 && !shot; angleDeg += 4) {
    const candidate = { angleDeg, power: 100 };
    const simulation = simulateShot({
      battlefield: state.battlefield,
      shooterSeat: "player1",
      shot: candidate,
      projectile: state.projectile,
    });
    if (simulation.impact.kind === "block" || simulation.impact.kind === "terrain") {
      shot = candidate;
    }
  }
  assert.ok(shot, "a structural/terrain impact must be reachable");

  let current = state;
  for (let index = 0; index < 6; index++) {
    const shooter = current.turn;
    const before = current.lives;
    current = applyShot(current, shooter, {
      angleDeg: shooter === "player1" ? shot.angleDeg : 180 - shot.angleDeg,
      power: shot.power,
    }).state;
    assert.deepEqual(current.lives, before, "damage alone never costs a life");
  }
});

test("the match ends immediately at zero lives and accepts nothing after", () => {
  const base = createInitialState({ seed: SEED, openingSeat: "player1" });
  const shot = openingHit(base);

  // A copy with the defender one life from elimination. The engine reads only
  // documented state fields, so a unit test can stage this directly.
  const oneLife = { ...base, lives: { ...base.lives, player2: 1 } };
  const { state: next, events } = applyShot(oneLife, "player1", shot);

  assert.equal(next.status, "finished");
  assert.equal(next.winner, "player1");
  assert.equal(next.terminationReason, "lives-exhausted");
  assert.equal(next.lives.player2, 0);
  assert.equal(next.shotsRemaining, 0, "the volley stops with the match");
  assert.equal(isMatchFinished(next), true);
  assert.ok(events.some((event) => event.type === "match-ended"));

  assert.equal(validateShot(next, "player1", SAFE_SHOT).code, "match-not-playing");
  assert.equal(validateShot(next, "player2", SAFE_SHOT).code, "match-not-playing");
  assert.throws(
    () => applyShot(next, "player1", shot),
    (error) => isHillstrikeRuleError(error) && error.code === "match-not-playing",
  );
});

test("a shot from the wrong seat is refused with a specific code", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });

  assert.deepEqual(validateShot(state, "player2", SAFE_SHOT), {
    ok: false,
    code: "not-your-turn",
    message: "It is not your turn",
  });
  assert.throws(
    () => applyShot(state, "player2", SAFE_SHOT),
    (error) => isHillstrikeRuleError(error) && error.code === "not-your-turn",
  );
});

test("an unknown or missing seat is refused", () => {
  const state = createInitialState({ seed: SEED });
  for (const seat of ["player3", null, undefined, 1, {}]) {
    assert.equal(validateShot(state, seat, SAFE_SHOT).code, "invalid-seat");
  }
});

test("malformed shots are rejected, never silently repaired", () => {
  const state = createInitialState({ seed: SEED });
  const shooter = state.openingSeat;

  const cases = [
    [{ angleDeg: Number.NaN, power: 50 }, "angle-invalid"],
    [{ angleDeg: Number.POSITIVE_INFINITY, power: 50 }, "angle-invalid"],
    [{ angleDeg: 360, power: 50 }, "angle-invalid"],
    [{ angleDeg: -1, power: 50 }, "angle-invalid"],
    [{ angleDeg: "45", power: 50 }, "angle-invalid"],
    [{ angleDeg: 45, power: 50.5 }, "power-invalid"],
    [{ angleDeg: 45, power: Number.NaN }, "power-invalid"],
    [{ angleDeg: 45, power: 101 }, "power-invalid"],
    [{ angleDeg: 45, power: -1 }, "power-invalid"],
    [null, "invalid-shot"],
    ["45", "invalid-shot"],
    [[45, 50], "invalid-shot"],
    [{ power: 50 }, "invalid-shot"],
    [{ angleDeg: 45 }, "invalid-shot"],
  ];

  for (const [shot, code] of cases) {
    const verdict = validateShot(state, shooter, shot);
    assert.equal(verdict.ok, false, `expected a rejection for ${JSON.stringify(shot)}`);
    assert.equal(verdict.code, code);
    assert.throws(() => applyShot(state, shooter, shot), (error) => isHillstrikeRuleError(error));
  }
});

test("a refused shot leaves the state byte-for-byte identical", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });
  const before = clone(state);

  assert.throws(() => applyShot(state, "player2", SAFE_SHOT), isHillstrikeRuleError);
  assert.throws(
    () => applyShot(state, "player1", { angleDeg: 90, power: 1000 }),
    isHillstrikeRuleError,
  );

  assert.deepEqual(clone(state), before);
});

test("the same state and shot always resolve identically", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });
  const shot = openingHit(state);

  const first = applyShot(state, "player1", shot);
  const second = applyShot(createInitialState({ seed: SEED, openingSeat: "player1" }), "player1", shot);

  assert.deepEqual(clone(first.state), clone(second.state));
  assert.deepEqual(clone(first.events), clone(second.events));
});

test("an event stream is ordered launch → impact → settlement", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });
  const { events } = applyShot(state, "player1", SAFE_SHOT);

  assert.equal(events[0].type, "launch");
  assert.equal(events[1].type, "impact");
  assert.equal(events[events.length - 1].type, "settled");
  for (let index = 1; index < events.length; index++) {
    assert.ok(
      events[index].tick >= events[index - 1].tick,
      "events never travel backwards in time",
    );
  }
});

test("tryApplyShot reports refusals instead of throwing", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });

  const refused = tryApplyShot(state, "player2", SAFE_SHOT);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "not-your-turn");

  const accepted = tryApplyShot(state, "player1", SAFE_SHOT);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.state.turnIndex, 1);
  assert.ok(accepted.events.length > 0);
});

test("a match records the shot it accepted, enough to animate it", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });
  const { state: next } = applyShot(state, "player1", SAFE_SHOT);
  const record = next.lastShot;

  assert.equal(record.seat, "player1");
  assert.equal(record.turnIndex, 0);
  assert.equal(record.shot.angleDeg, SAFE_SHOT.angleDeg);
  assert.ok(record.path.length >= 2);
  assert.ok(record.path.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
  assert.ok(record.events.length > 0);
  assert.equal(record.impact.kind, "terrain");
  const lastPoint = record.path[record.path.length - 1];
  assert.equal(lastPoint.x, record.impact.x, "the path ends at the recorded impact");
  assert.equal(lastPoint.y, record.impact.y);
});
