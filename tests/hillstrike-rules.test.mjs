/**
 * hillstrike-rules.test.mjs
 *
 * The PURE rules engine: match creation, battlefield fairness, the
 * one-action-then-two state machine, HP and the distance-scaled damage, the two
 * actions (shoot / move), the middle tower that gates the map, the match clock,
 * immediate termination, rejection of invalid or out-of-turn actions,
 * immutability and determinism.
 *
 * Everything asserted here goes through the engine's published API only:
 * `createInitialState`, `validateAction`, `applyAction`, `tryApplyAction`.
 * Physics is exercised as a black box — the suite FINDS a legal firing solution
 * instead of hard-coding a tuning-dependent angle, so a balance change does not
 * break the rules tests.
 *
 * Run:  node --import tsx --test tests/hillstrike-rules.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

const {
  createInitialState,
  validateAction,
  applyAction,
  tryApplyAction,
  isHillstrikeRuleError,
  isMatchFinished,
  otherSeat,
  hpOf,
  hpLeaderOf,
  finishOnTime,
  moveTargetFor,
  buffsOf,
  spawnXFor,
} = await import("../src/lib/hillstrike/rules.ts");
const { simulateShot, damageForDistance, powerScaleForDistance } = await import(
  "../src/lib/hillstrike/physics.ts"
);
const {
  createBattlefield,
  openingSeatFor,
  validateBattlefield,
  surfaceYAt,
  groundYUnder,
} = await import("../src/lib/hillstrike/generation.ts");
const {
  FIELD_VERSION,
  MAX_HP,
  OPENING_ACTIONS,
  ACTIONS_PER_TURN,
  MOVE_STEP,
  MOVE_RANGE,
  MOVE_EDGE_MARGIN,
  PLAYER_RADIUS,
  BASE_ROOF_BLOCKS,
  HIT_DAMAGE_MAX,
  POWERUP_HEAL_AMOUNT,
  STRUCTURE_BLOCK_SIZE,
  BATTLEFIELD_WIDTH,
  TOWER_BLOCK_INTEGRITY,
  TOWER_COLUMNS,
} = await import("../src/lib/hillstrike/constants.ts");

const SEED = 12345;

/** A shot that cannot hit anybody: straight up, minimum power. */
const SAFE_SHOT = Object.freeze({ type: "shoot", angleDeg: 90, power: 0 });

/**
 * A shot that leaves the battlefield without touching anything, so the turn can
 * advance without changing the terrain (used when the next seat's firing
 * solution must be searched on the untouched battlefield).
 */
const PASS_SHOT = Object.freeze({
  player1: Object.freeze({ type: "shoot", angleDeg: 170, power: 100 }),
  player2: Object.freeze({ type: "shoot", angleDeg: 10, power: 100 }),
});

/**
 * Search for a shot that directly hits the defender.
 *
 * The hit window on a real battlefield is narrow (the walls eat most lines), so
 * the search is a fine grid: 0.5° of angle over the whole forward arc at every
 * power band. It still runs the real physics, so the found solution is a
 * genuine engine hit, not a fixture.
 */
function findHitShot(battlefield, seat, projectile) {
  for (let power = 100; power >= 60; power -= 5) {
    for (let angleDeg = 0; angleDeg < 180; angleDeg += 0.5) {
      const candidate = { angleDeg, power };
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
  }
  return null;
}

/** A hit shot from whichever seat opens the given state. */
function openingHit(state) {
  const shot = findHitShot(state.battlefield, state.openingSeat, state.projectile);
  assert.ok(shot, "the engine must expose at least one legal direct hit");
  return { type: "shoot", ...shot };
}

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * A state with the middle tower removed.
 *
 * The tower is a full-height gate, so a spawn-to-spawn direct hit no longer exists
 * on a dealt battlefield — that IS the rule, and it is tested on its own below.
 * The combat tests here need a line of fire to exercise HP, damage, turns and the
 * buffs, so they play on a copy of the same battlefield with the gate opened.
 */
function openField(state) {
  return {
    ...state,
    battlefield: {
      ...state.battlefield,
      blocks: state.battlefield.blocks.filter((block) => block.kind !== "tower"),
    },
  };
}

/** A state where the acting seat can take as many actions as the test needs. */
const withActions = (state, count) => ({ ...state, actionsRemaining: count });

test("a new match has the agreed shape", () => {
  const state = createInitialState({ seed: SEED });

  assert.equal(state.status, "playing");
  assert.equal(state.fieldVersion, FIELD_VERSION);
  assert.equal(state.seed, SEED);
  assert.equal(hpOf(state, "player1"), MAX_HP);
  assert.equal(hpOf(state, "player2"), MAX_HP);
  assert.deepEqual(state.hp, { player1: MAX_HP, player2: MAX_HP });
  assert.equal(state.turn, state.openingSeat);
  assert.equal(state.turnIndex, 0);
  assert.equal(state.actionsRemaining, OPENING_ACTIONS);
  assert.equal(state.openingShotPending, true);
  assert.equal(state.winner, null);
  assert.equal(state.terminationReason, null);
  assert.equal(state.lastAction, null);
  assert.equal("lives" in state, false, "v1 lives are gone");

  assert.deepEqual(validateBattlefield(state.battlefield), { ok: true });
  assert.equal(state.battlefield.blocks.length > 0, true);
  assert.equal(Object.isFrozen(state), true, "state is deeply frozen");
  assert.equal(Object.isFrozen(state.battlefield.terrain), true);
  assert.equal(Object.isFrozen(state.hp), true);
});

test("each seat starts under an indestructible roof, with no wall in front", () => {
  const state = createInitialState({ seed: SEED });

  for (const seat of ["player1", "player2"]) {
    const own = state.battlefield.blocks.filter((block) => block.seat === seat);
    assert.equal(own.length, BASE_ROOF_BLOCKS, `${seat} gets a ${BASE_ROOF_BLOCKS}-block roof`);
    assert.ok(own.every((block) => block.kind === "roof"));

    const spawn = state.battlefield.players[seat];
    const left = Math.min(...own.map((block) => block.x));
    const right = Math.max(...own.map((block) => block.x + block.size));
    // The roof is a CEILING over the spawn, and it is the same height all across.
    assert.ok(own.every((block) => block.y === own[0].y), "the roof is flat");
    assert.ok(own[0].y + own[0].size < spawn.y, "the roof is above the tank");
    assert.ok(left <= spawn.x && spawn.x <= right, `${seat}'s roof covers its spawn`);

    // No WALL in front: nothing between the tank and the enemy that reaches down
    // to hull height. The roof is overhead, which is the whole redesign.
    const hullTop = spawn.y - 60;
    const wallInFront = state.battlefield.blocks.filter((block) => {
      const ahead = seat === "player1"
        ? block.x >= spawn.x + PLAYER_RADIUS
        : block.x + block.size <= spawn.x - PLAYER_RADIUS;
      return ahead && block.y + block.size > hullTop;
    });
    assert.deepEqual(wallInFront, [], `${seat} starts with no wall in front`);
  }
});

test("the base roof swallows a shot: it is indestructible and changes nothing", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });
  const straightUp = { angleDeg: 90, power: 100 };
  const simulation = simulateShot({
    battlefield: state.battlefield,
    shooterSeat: "player1",
    shot: straightUp,
    projectile: state.projectile,
  });

  assert.equal(simulation.impact.kind, "block");
  const roof = state.battlefield.blocks.find((block) => block.id === simulation.impact.blockId);
  assert.ok(roof, "the impact names the block it met");
  assert.equal(roof.kind, "roof");
  assert.deepEqual(simulation.battlefield.blocks, state.battlefield.blocks, "no block breaks");
  assert.deepEqual(simulation.battlefield.terrain, state.battlefield.terrain, "no crater is carved");
});

test("the middle deals a mirrored set of power-ups on the ground", () => {
  const state = createInitialState({ seed: SEED });
  const pickups = state.battlefield.pickups;
  assert.ok(pickups.length >= 3, "the middle deals at least three pickups");
  assert.ok(pickups.some((pickup) => pickup.kind === "heal"));
  assert.ok(pickups.some((pickup) => pickup.kind === "double-damage"));
  assert.ok(pickups.some((pickup) => pickup.kind === "double-blast"));

  const centre = BATTLEFIELD_WIDTH / 2;
  for (const pickup of pickups) {
    const mirrored = pickups.find((other) => other.kind === pickup.kind && other.x === 2 * centre - pickup.x);
    if (pickup.x !== centre) {
      assert.ok(mirrored, `${pickup.kind} at ${pickup.x} must have a mirror`);
    }
    const surface = surfaceYAt(state.battlefield.terrain, pickup.x);
    assert.ok(pickup.y < surface, `${pickup.kind} floats above its ground`);
    assert.ok(surface - pickup.y <= 30, `${pickup.kind} sits on the ground, not in the air`);
  }
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
    "both tanks stand at the same height",
  );
});

test("the opening seat is drawn from the seed and recorded", () => {
  const state = createInitialState({ seed: SEED });
  assert.equal(state.openingSeat, openingSeatFor(SEED));
  assert.equal(createInitialState({ seed: SEED }).openingSeat, state.openingSeat);

  const seats = new Set();
  for (let seed = 0; seed < 24; seed++) seats.add(openingSeatFor(seed));
  assert.deepEqual([...seats].sort(), ["player1", "player2"]);
});

test("the opening seat can be overridden for a scripted board", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });
  assert.equal(state.openingSeat, "player1");
  assert.equal(state.turn, "player1");
  assert.equal(state.actionsRemaining, 1);

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

test("the opening turn is one action, then the seats alternate two", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });

  const afterOpening = applyAction(state, "player1", SAFE_SHOT).state;
  assert.equal(afterOpening.turn, "player2");
  assert.equal(afterOpening.actionsRemaining, ACTIONS_PER_TURN);
  assert.equal(afterOpening.openingShotPending, false);
  assert.equal(afterOpening.turnIndex, 1);

  const afterFirstOfTwo = applyAction(afterOpening, "player2", SAFE_SHOT).state;
  assert.equal(afterFirstOfTwo.turn, "player2", "the turn continues");
  assert.equal(afterFirstOfTwo.actionsRemaining, 1);

  const afterTwo = applyAction(afterFirstOfTwo, "player2", SAFE_SHOT).state;
  assert.equal(afterTwo.turn, "player1");
  assert.equal(afterTwo.actionsRemaining, 2);
  assert.equal(afterTwo.turnIndex, 3);

  const afterNext = applyAction(afterTwo, "player1", SAFE_SHOT).state;
  assert.equal(afterNext.turn, "player1", "two-action turns from here on");
  assert.equal(afterNext.actionsRemaining, 1);
});

test("a direct hit takes HP from the distance the shell flew, and only the victim's", () => {
  const state = openField(createInitialState({ seed: SEED, openingSeat: "player1" }));
  const shot = openingHit(state);
  const before = clone(state);

  const { state: next, events } = applyAction(state, "player1", shot);

  const simulation = simulateShot({
    battlefield: state.battlefield,
    shooterSeat: "player1",
    shot: { angleDeg: shot.angleDeg, power: shot.power },
    projectile: state.projectile,
  });
  const expected = damageForDistance(simulation.distance);

  assert.ok(expected >= 1 && expected <= HIT_DAMAGE_MAX, "damage stays in range");
  assert.equal(next.hp.player2, MAX_HP - expected);
  assert.equal(next.hp.player1, MAX_HP);
  assert.equal(next.turnIndex, 1);
  assert.equal(next.status, "playing");
  assert.equal(next.winner, null);
  assert.equal(next.lastAction.type, "shoot");
  assert.equal(next.lastAction.damage, expected);
  assert.equal(Math.round(next.lastAction.distance), Math.round(simulation.distance));
  assert.equal(next.lastAction.impact.kind, "player");
  assert.equal(next.lastAction.impact.target, "player2");

  assert.deepEqual(
    next.battlefield,
    state.battlefield,
    "a tank hit changes no terrain and no structure",
  );
  assert.ok(events.some((event) => event.type === "player-hit"));
  const hpEvent = events.filter((event) => event.type === "hp-lost");
  assert.equal(hpEvent.length, 1);
  assert.equal(hpEvent[0].seat, "player2");
  assert.equal(hpEvent[0].damage, expected);
  assert.equal(hpEvent[0].hp, MAX_HP - expected);
  assert.deepEqual(clone(state), before, "the input state is untouched");
});

test("a longer shot hits a tank for less, and distance changes nothing else", () => {
  // The falloff is one published function and it applies to ONE quantity: the HP
  // a direct hit takes. Crater size and block breaking are fixed (see the physics
  // suite), so this is no longer a blast curve.
  const near = 400;
  const mid = 1000;
  const far = 1450;

  assert.ok(powerScaleForDistance(near) > powerScaleForDistance(mid));
  assert.ok(powerScaleForDistance(mid) > powerScaleForDistance(far));
  assert.ok(damageForDistance(near) > damageForDistance(mid));
  assert.ok(damageForDistance(mid) > damageForDistance(far));

  // Floors and ceilings: a hit always hurts, and never exceeds the maximum.
  assert.equal(damageForDistance(0), HIT_DAMAGE_MAX);
  assert.ok(damageForDistance(100000) >= 1);
  assert.equal(powerScaleForDistance(100000), powerScaleForDistance(5000), "the floor holds");
});

test("the opening seat's turn ends after a hit, because it is only one action", () => {
  const state = openField(createInitialState({ seed: SEED, openingSeat: "player1" }));
  const next = applyAction(state, "player1", openingHit(state)).state;

  assert.ok(next.hp.player2 < MAX_HP);
  assert.equal(next.turn, "player2");
  assert.equal(next.actionsRemaining, ACTIONS_PER_TURN);
});

test("a hit during a two-action turn keeps the turn", () => {
  let state = openField(createInitialState({ seed: SEED, openingSeat: "player1" }));
  // A pass leaves the battlefield untouched, so player2's firing solution is
  // searched on exactly the terrain the match started on.
  const passed = applyAction(state, "player1", PASS_SHOT.player1).state;
  assert.equal(passed.turn, "player2");
  assert.deepEqual(passed.battlefield, state.battlefield);
  state = passed;

  const shot = findHitShot(state.battlefield, "player2", state.projectile);
  assert.ok(shot, "player2 must also have a direct firing solution");

  const next = applyAction(state, "player2", { type: "shoot", ...shot }).state;
  assert.ok(next.hp.player1 < MAX_HP);
  assert.equal(next.turn, "player2");
  assert.equal(next.actionsRemaining, 1, "the second action of the turn remains");
});

test("structural and terrain damage never cost HP", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });

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
    const before = current.hp;
    current = applyAction(current, shooter, {
      type: "shoot",
      angleDeg: shooter === "player1" ? shot.angleDeg : 180 - shot.angleDeg,
      power: shot.power,
    }).state;
    assert.deepEqual(current.hp, before, "damage alone never costs HP");
  }
});

test("the match ends immediately at zero HP and accepts nothing after", () => {
  const base = openField(createInitialState({ seed: SEED, openingSeat: "player1" }));
  const shot = openingHit(base);

  // A copy with the defender one hit from elimination. The engine reads only
  // documented state fields, so a unit test can stage this directly.
  const oneHitFromOut = { ...base, hp: { ...base.hp, player2: 1 } };
  const { state: next, events } = applyAction(oneHitFromOut, "player1", shot);

  assert.equal(next.status, "finished");
  assert.equal(next.winner, "player1");
  assert.equal(next.terminationReason, "hp-depleted");
  assert.equal(next.hp.player2, 0);
  assert.equal(next.actionsRemaining, 0, "the turn stops with the match");
  assert.equal(isMatchFinished(next), true);
  assert.ok(events.some((event) => event.type === "match-ended"));

  assert.equal(validateAction(next, "player1", SAFE_SHOT).code, "match-not-playing");
  assert.equal(validateAction(next, "player2", SAFE_SHOT).code, "match-not-playing");
  assert.throws(
    () => applyAction(next, "player1", shot),
    (error) => isHillstrikeRuleError(error) && error.code === "match-not-playing",
  );
});

test("a drive moves the tank along the surface and spends one action", () => {
  const base = createInitialState({ seed: SEED, openingSeat: "player1" });
  const start = base.battlefield.players.player1;
  const target = moveTargetFor(base, "player1", "forward");

  assert.ok(target, "there is room to drive forward from the spawn");
  assert.equal(target.x, start.x + MOVE_STEP);
  assert.equal(target.y, surfaceYAt(base.battlefield.terrain, target.x));

  const { state: next, events } = applyAction(base, "player1", {
    type: "move",
    direction: "forward",
  });

  assert.deepEqual(next.battlefield.players.player1, {
    seat: "player1",
    x: target.x,
    y: target.y,
  });
  assert.deepEqual(next.battlefield.players.player2, base.battlefield.players.player2);
  assert.deepEqual(next.hp, base.hp, "a drive costs no HP");
  assert.equal(next.turn, "player2", "the opening action was the only one");
  assert.equal(next.actionsRemaining, ACTIONS_PER_TURN);
  assert.equal(next.lastAction.type, "move");
  assert.equal(next.lastAction.fromX, start.x);
  assert.equal(next.lastAction.toX, target.x);
  assert.ok(events.some((event) => event.type === "moved"));
});

test("a tank can drive back as well as forward, and never past its leash", () => {
  const base = createInitialState({ seed: SEED, openingSeat: "player1" });
  let state = withActions(base, 50);

  // Forward until the engine refuses: the tank stops exactly MOVE_RANGE out.
  let steps = 0;
  while (validateAction(state, "player1", { type: "move", direction: "forward" }).ok) {
    state = applyAction(state, "player1", { type: "move", direction: "forward" }).state;
    steps += 1;
    assert.ok(steps < 20, "the drive loop is bounded");
  }
  const forward = state.battlefield.players.player1;
  // The tower is the first limit on the drive: the leash reaches past the middle
  // of the map, so a full forward run stops at the tower's near face.
  const towerLeft = Math.min(
    ...state.battlefield.blocks
      .filter((block) => block.kind === "tower")
      .map((block) => block.x),
  );
  assert.ok(forward.x + PLAYER_RADIUS <= towerLeft, "the drive stops at the tower");
  assert.ok(forward.x <= spawnXFor("player1") + MOVE_RANGE, "and never passes the leash");
  assert.equal(validateAction(state, "player1", { type: "move", direction: "forward" }).code, "move-blocked");

  // And back, through the spawn, out to the other end of the leash.
  while (validateAction(state, "player1", { type: "move", direction: "back" }).ok) {
    state = applyAction(state, "player1", { type: "move", direction: "back" }).state;
  }
  // The leash reaches the middle of the doubled map, so backing up runs into the
  // FIELD edge before it runs out of range: no drive may ever leave the map.
  const back = state.battlefield.players.player1;
  assert.equal(back.x, MOVE_EDGE_MARGIN + PLAYER_RADIUS);
  assert.equal(back.y, surfaceYAt(state.battlefield.terrain, back.x));
  assert.ok(spawnXFor("player1") - MOVE_RANGE < back.x, "the map clamps the leash");
});

test("player2 drives toward the left, mirroring player1", () => {
  const base = createInitialState({ seed: SEED, openingSeat: "player2" });
  const start = base.battlefield.players.player2;
  const next = applyAction(base, "player2", { type: "move", direction: "forward" }).state;

  assert.equal(next.battlefield.players.player2.x, start.x - MOVE_STEP);
});

test("there is no build action any more", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });
  const before = state.battlefield.blocks.length;

  for (const action of [
    { type: "build" },
    { type: "build", x: 200, y: 400 },
    { type: "BUILD", x: 200, y: 400 },
  ]) {
    const verdict = validateAction(state, "player1", action);
    assert.equal(verdict.ok, false, "a build is not an action the engine accepts");
    assert.equal(verdict.code, "invalid-action");
    assert.throws(
      () => applyAction(state, "player1", action),
      (error) => isHillstrikeRuleError(error) && error.code === "invalid-action",
    );
  }

  // The only structures are the two base roofs and the middle tower: nothing can
  // ever add one, so the count is fixed for the whole match.
  assert.equal(state.battlefield.blocks.length, before);
  const kinds = new Set(state.battlefield.blocks.map((block) => block.kind));
  assert.deepEqual([...kinds].sort(), ["roof", "tower"]);
});

test("the middle tower walls the map from the ground to the sky", () => {
  for (const seed of [SEED, 1, 2, 3, 999]) {
    const state = createInitialState({ seed, openingSeat: "player1" });
    const tower = state.battlefield.blocks.filter((block) => block.kind === "tower");
    assert.ok(tower.length > 0, "every layout deals a tower");
    assert.ok(
      tower.every((block) => block.seat === null),
      "the tower belongs to neither seat",
    );
    assert.ok(
      tower.every((block) => block.integrity === TOWER_BLOCK_INTEGRITY),
      "every tower block starts at its full integrity",
    );

    // Three columns wide, centred on the map, and the top row starts at the sky.
    const left = Math.min(...tower.map((block) => block.x));
    const right = Math.max(...tower.map((block) => block.x + block.size));
    assert.equal(right - left, TOWER_COLUMNS * STRUCTURE_BLOCK_SIZE);
    assert.equal((left + right) / 2, BATTLEFIELD_WIDTH / 2, "the tower is centred");
    assert.equal(Math.min(...tower.map((block) => block.y)), 0, "it reaches the sky");

    // The columns are FULL: no vertical gap a shell could thread through.
    for (let column = 0; column < TOWER_COLUMNS; column++) {
      const x = left + column * STRUCTURE_BLOCK_SIZE;
      const columnBlocks = tower
        .filter((block) => block.x === x)
        .map((block) => block.y)
        .sort((a, b) => a - b);
      for (let index = 1; index < columnBlocks.length; index++) {
        assert.equal(
          columnBlocks[index],
          columnBlocks[index - 1] + STRUCTURE_BLOCK_SIZE,
          "tower rows are contiguous",
        );
      }
    }

    // NOTHING crosses it: no legal shot reaches the defender, whatever the arc.
    let crossingHit = null;
    for (let angleDeg = 4; angleDeg <= 86 && !crossingHit; angleDeg += 2) {
      for (let power = 40; power <= 100 && !crossingHit; power += 10) {
        const simulation = simulateShot({
          battlefield: state.battlefield,
          shooterSeat: "player1",
          shot: { angleDeg, power },
          projectile: state.projectile,
        });
        if (simulation.impact.kind === "player") crossingHit = { angleDeg, power };
      }
    }
    assert.equal(crossingHit, null, "the tower seals the map (no spawn-to-spawn hit)");

  }
});

/**
 * Search for a shot that lands ON the middle tower from a given seat's spawn.
 *
 * The tower is a wall, so a shot that reaches it is a real engine hit — the test
 * does not hard-code an angle that a tuning change would invalidate.
 */
function findTowerShot(battlefield, seat, projectile) {
  const towerIds = new Set(
    battlefield.blocks.filter((block) => block.kind === "tower").map((block) => block.id),
  );
  for (let power = 100; power >= 30; power -= 10) {
    for (let angleDeg = 4; angleDeg <= 86; angleDeg += 1) {
      const angle = seat === "player1" ? angleDeg : 180 - angleDeg;
      const impact = simulateShot({
        battlefield,
        shooterSeat: seat,
        shot: { angleDeg: angle, power },
        projectile,
      }).impact;
      if (impact.kind === "block" && towerIds.has(impact.blockId)) {
        return { angleDeg: angle, power };
      }
    }
  }
  return null;
}

test("the tower breaks where it is shot, and a hole stays a hole", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });

  let current = state;
  const damagedIds = new Set();
  const destroyedIds = new Set();
  for (let index = 0; index < 6; index++) {
    const shooter = current.turn;
    const shot = findTowerShot(current.battlefield, shooter, current.projectile);
    assert.ok(shot, "the tower is reachable from a spawn");
    const next = applyAction(current, shooter, { type: "shoot", ...shot }).state;
    const record = next.lastAction;
    assert.equal(record.impact.kind, "block", "the tower is in the way");
    for (const event of record.events) {
      if (event.type === "block-damaged") damagedIds.add(event.blockId);
      if (event.type === "block-destroyed") destroyedIds.add(event.blockId);
    }
    current = next;
  }
  assert.ok(destroyedIds.size > 0, "tower blocks are destroyed once their integrity is spent");
  assert.ok(
    current.battlefield.blocks.length < state.battlefield.blocks.length,
    "the tower loses blocks",
  );

  // ANCHORED: no tower block ever collapses, so the hole shot into it stays open
  // instead of being filled from above.
  for (const block of current.battlefield.blocks) {
    if (block.kind !== "tower") continue;
    const original = state.battlefield.blocks.find((candidate) => candidate.id === block.id);
    assert.ok(original);
    assert.equal(block.x, original.x, "a tower block never moves sideways");
    assert.equal(block.y, original.y, "a tower block never falls into a hole");
  }
});

test("the clock: more HP wins, level HP is a draw, and nothing is invented", () => {
  const state = openField(createInitialState({ seed: SEED, openingSeat: "player1" }));

  const behind = { ...state, hp: { player1: 40, player2: 90 } };
  assert.equal(hpLeaderOf(behind), "player2");
  const { state: won, events } = finishOnTime(behind);
  assert.equal(won.status, "finished");
  assert.equal(won.winner, "player2", "the tank with the most HP wins");
  assert.equal(won.terminationReason, "timed-out");
  assert.equal(won.actionsRemaining, 0, "the turn stops with the match");
  assert.deepEqual(won.hp, behind.hp, "a timeout never fabricates damage");
  assert.ok(events.some((event) => event.type === "match-ended" && event.reason === "timed-out"));
  assert.equal(validateAction(won, won.turn, SAFE_SHOT).code, "match-not-playing");

  const level = { ...state, hp: { player1: 70, player2: 70 } };
  assert.equal(hpLeaderOf(level), null);
  const { state: drawn, events: drawEvents } = finishOnTime(level);
  assert.equal(drawn.status, "finished");
  assert.equal(drawn.winner, null, "level HP is a draw, not a coin flip");
  assert.equal(drawn.terminationReason, "timed-out");
  assert.deepEqual(drawEvents, [], "a draw announces no winner");

  // A finished match is returned untouched.
  const already = finishOnTime(won);
  assert.equal(already.state, won);
  assert.deepEqual(already.events, []);
});

test("a shot from the wrong seat is refused with a specific code", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });

  assert.deepEqual(validateAction(state, "player2", SAFE_SHOT), {
    ok: false,
    code: "not-your-turn",
    message: "It is not your turn",
  });
  assert.throws(
    () => applyAction(state, "player2", SAFE_SHOT),
    (error) => isHillstrikeRuleError(error) && error.code === "not-your-turn",
  );

  // A drive is an action too, not a free move.
  assert.equal(
    validateAction(state, "player2", { type: "move", direction: "forward" }).code,
    "not-your-turn",
  );
});

test("an unknown or missing seat is refused", () => {
  const state = createInitialState({ seed: SEED });
  for (const seat of ["player3", null, undefined, 1, {}]) {
    assert.equal(validateAction(state, seat, SAFE_SHOT).code, "invalid-seat");
  }
});

test("malformed actions are rejected, never silently repaired", () => {
  const state = createInitialState({ seed: SEED });
  const shooter = state.openingSeat;

  const cases = [
    [{ type: "shoot", angleDeg: Number.NaN, power: 50 }, "angle-invalid"],
    [{ type: "shoot", angleDeg: Number.POSITIVE_INFINITY, power: 50 }, "angle-invalid"],
    [{ type: "shoot", angleDeg: 360, power: 50 }, "angle-invalid"],
    [{ type: "shoot", angleDeg: -1, power: 50 }, "angle-invalid"],
    [{ type: "shoot", angleDeg: "45", power: 50 }, "angle-invalid"],
    [{ type: "shoot", angleDeg: 45, power: 50.5 }, "power-invalid"],
    [{ type: "shoot", angleDeg: 45, power: Number.NaN }, "power-invalid"],
    [{ type: "shoot", angleDeg: 45, power: 101 }, "power-invalid"],
    [{ type: "shoot", angleDeg: 45, power: -1 }, "power-invalid"],
    [{ type: "shoot", power: 50 }, "invalid-shot"],
    [{ type: "shoot", angleDeg: 45 }, "invalid-shot"],
    [{ type: "move", direction: "sideways" }, "invalid-direction"],
    [{ type: "move" }, "invalid-direction"],
    [{ type: "jump" }, "invalid-action"],
    [{}, "invalid-action"],
    [null, "invalid-action"],
    ["shoot", "invalid-action"],
  ];

  for (const [action, code] of cases) {
    const verdict = validateAction(state, shooter, action);
    assert.equal(verdict.ok, false, `expected a rejection for ${JSON.stringify(action)}`);
    assert.equal(verdict.code, code);
    assert.throws(() => applyAction(state, shooter, action), (error) => isHillstrikeRuleError(error));
  }
});

test("a refused action leaves the state byte-for-byte identical", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });
  const before = clone(state);

  assert.throws(() => applyAction(state, "player2", SAFE_SHOT), isHillstrikeRuleError);
  assert.throws(
    () => applyAction(state, "player1", { type: "shoot", angleDeg: 90, power: 1000 }),
    isHillstrikeRuleError,
  );
  assert.throws(
    () => applyAction(state, "player1", { type: "move", direction: "sideways" }),
    isHillstrikeRuleError,
  );

  assert.deepEqual(clone(state), before);
});

test("the same state and action always resolve identically", () => {
  const state = openField(createInitialState({ seed: SEED, openingSeat: "player1" }));
  const shot = openingHit(state);

  const first = applyAction(state, "player1", shot);
  const second = applyAction(
    openField(createInitialState({ seed: SEED, openingSeat: "player1" })),
    "player1",
    shot,
  );

  assert.deepEqual(clone(first.state), clone(second.state));
  assert.deepEqual(clone(first.events), clone(second.events));

  const driveA = applyAction(state, "player1", { type: "move", direction: "forward" });
  const driveB = applyAction(state, "player1", { type: "move", direction: "forward" });
  assert.deepEqual(clone(driveA.state), clone(driveB.state));

  // A tower shot is deterministic too, including which block it breaks.
  const towerShot = { type: "shoot", angleDeg: 30, power: 100 };
  const towerA = applyAction(state, "player1", towerShot);
  const towerB = applyAction(
    openField(createInitialState({ seed: SEED, openingSeat: "player1" })),
    "player1",
    towerShot,
  );
  assert.deepEqual(clone(towerA.state), clone(towerB.state));
});

test("an event stream is ordered launch → impact → settlement", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });
  const { events } = applyAction(state, "player1", SAFE_SHOT);

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

test("tryApplyAction reports refusals instead of throwing", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });

  const refused = tryApplyAction(state, "player2", SAFE_SHOT);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "not-your-turn");

  const accepted = tryApplyAction(state, "player1", SAFE_SHOT);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.state.turnIndex, 1);
  assert.ok(accepted.events.length > 0);
});

test("a match records the action it accepted, enough to animate it", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });
  const { state: next } = applyAction(state, "player1", SAFE_SHOT);
  const record = next.lastAction;

  assert.equal(record.type, "shoot");
  assert.equal(record.seat, "player1");
  assert.equal(record.turnIndex, 0);
  assert.equal(record.shot.angleDeg, SAFE_SHOT.angleDeg);
  assert.ok(record.path.length >= 2);
  assert.ok(record.path.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
  assert.ok(record.events.length > 0);
  assert.ok(record.distance >= 0);
  assert.ok(record.powerScale > 0 && record.powerScale <= 1);
  assert.equal(record.impact.kind, "terrain");
  assert.equal(record.damage, 0, "a ground hit costs no HP");
  const lastPoint = record.path[record.path.length - 1];
  assert.equal(lastPoint.x, record.impact.x, "the path ends at the recorded impact");
  assert.equal(lastPoint.y, record.impact.y);
});

test("driving over a heal pickup restores HP and removes the pickup", () => {
  const base = createInitialState({ seed: SEED, openingSeat: "player1" });
  const target = moveTargetFor(base, "player1", "forward");
  assert.ok(target);
  const staged = {
    ...base,
    hp: { player1: 40, player2: MAX_HP },
    battlefield: {
      ...base.battlefield,
      pickups: [
        {
          id: 77,
          kind: "heal",
          x: target.x,
          y: target.y - PLAYER_RADIUS,
        },
      ],
    },
  };

  const { state: next, events } = applyAction(staged, "player1", {
    type: "move",
    direction: "forward",
  });

  assert.equal(next.hp.player1, 40 + POWERUP_HEAL_AMOUNT);
  assert.equal(next.hp.player2, MAX_HP, "only the collector is healed");
  assert.deepEqual(next.battlefield.pickups, [], "the pickup is spent");
  assert.ok(events.some((event) => event.type === "pickup-collected"));
  const healed = events.find((event) => event.type === "healed");
  assert.equal(healed.amount, POWERUP_HEAL_AMOUNT);
  assert.equal(healed.hp, next.hp.player1);
});

test("a collected pickup is gone for good — nothing respawns", () => {
  const base = createInitialState({ seed: SEED, openingSeat: "player1" });
  const target = moveTargetFor(base, "player1", "forward");
  assert.ok(target);
  const staged = {
    ...base,
    battlefield: {
      ...base.battlefield,
      pickups: [
        { id: 77, kind: "double-damage", x: target.x, y: target.y - PLAYER_RADIUS },
      ],
    },
  };

  const { state: collected } = applyAction(staged, "player1", {
    type: "move",
    direction: "forward",
  });
  assert.deepEqual(collected.battlefield.pickups, [], "the pickup is spent on collection");
  assert.equal(
    "respawns" in collected.battlefield,
    false,
    "there is no respawn queue any more",
  );

  // Keep playing: nothing ever deals that pickup again.
  let state = collected;
  for (let index = 0; index < 10; index++) {
    const seat = state.turn;
    const drive = { type: "move", direction: "backward" };
    const action = validateAction(state, seat, drive).ok ? drive : SAFE_SHOT;
    state = applyAction(state, seat, action).state;
    assert.equal(
      state.battlefield.pickups.some((pickup) => pickup.id === 77),
      false,
      "a collected pickup never comes back",
    );
  }
});

test("double damage doubles the next shot and is spent by firing, hit or miss", () => {
  const state = openField(createInitialState({ seed: SEED, openingSeat: "player1" }));
  const shot = openingHit(state);
  const plain = applyAction(state, "player1", shot).state;
  assert.ok(plain.lastAction.damage > 0, "the baseline shot connects");

  const armed = {
    ...state,
    buffs: { ...state.buffs, player1: { doubleDamage: true, doubleBlast: false } },
  };
  const doubled = applyAction(armed, "player1", shot).state;
  assert.equal(
    doubled.lastAction.damage,
    Math.min(MAX_HP, plain.lastAction.damage * 2),
    "double damage doubles the HP the same shot takes",
  );
  assert.equal(doubled.lastAction.buffs.doubleDamage, true, "the record shows what was spent");
  assert.deepEqual(
    buffsOf(doubled, "player1"),
    { doubleDamage: false, doubleBlast: false },
    "firing spends the buff",
  );
  assert.deepEqual(plain.lastAction.buffs, { doubleDamage: false, doubleBlast: false });

  // A shot that hits nothing still spends it.
  const missed = applyAction(armed, "player1", { type: "shoot", angleDeg: 90, power: 0 }).state;
  assert.deepEqual(buffsOf(missed, "player1"), { doubleDamage: false, doubleBlast: false });
  assert.equal(missed.hp.player2, MAX_HP);
});

test("double blast widens the crater without changing tank damage", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });
  // A low, hard shot ploughs into the ground in front of the tank.
  const groundShot = { type: "shoot", angleDeg: 12, power: 100 };
  const plain = applyAction(state, "player1", groundShot).state;
  assert.equal(plain.lastAction.impact.kind, "terrain", "the reference shot hits ground");

  const armed = {
    ...state,
    buffs: { ...state.buffs, player1: { doubleDamage: false, doubleBlast: true } },
  };
  const doubled = applyAction(armed, "player1", groundShot).state;
  assert.equal(doubled.lastAction.impact.kind, "terrain");

  const carve = (next) => {
    let total = 0;
    for (let column = 0; column < next.battlefield.terrain.length; column++) {
      total += next.battlefield.terrain[column] - state.battlefield.terrain[column];
    }
    return total;
  };
  assert.ok(carve(plain) > 0, "a ground hit carves something");
  assert.ok(
    carve(doubled) > carve(plain),
    `double blast must carve more (${carve(doubled)} vs ${carve(plain)})`,
  );
  assert.equal(doubled.lastAction.damage, 0, "a crater never costs HP");
  assert.deepEqual(buffsOf(doubled, "player1"), { doubleDamage: false, doubleBlast: false });
});

test("a legacy lives state is read as full HP instead of NaN", () => {
  const state = createInitialState({ seed: SEED, openingSeat: "player1" });
  const legacy = { ...state, hp: undefined, lives: { player1: 2, player2: 1 } };

  assert.equal(hpOf(legacy, "player1"), MAX_HP);
  assert.equal(hpOf(legacy, "player2"), MAX_HP);
  // And an accepted action still produces usable numbers.
  const next = applyAction(legacy, "player1", SAFE_SHOT).state;
  assert.equal(next.hp.player1, MAX_HP);
});
