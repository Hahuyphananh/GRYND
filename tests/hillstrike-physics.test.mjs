/**
 * hillstrike-physics.test.mjs
 *
 * The deterministic simulator and the battlefield generator:
 *
 *   • aim conversion (angle/power, drag gestures) and strict input validation
 *   • battlefield reproducibility, mirror fairness and corruption rejection
 *   • fixed-step ballistics that always terminate inside their limits
 *   • travelled segments (never tunnelling through players, blocks or ground)
 *   • bounded, integer terrain deformation
 *   • deterministic, bounded structural damage and collapse with no floating,
 *     overlapping or out-of-bounds blocks
 *
 * Run:  node --import tsx --test tests/hillstrike-physics.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

const {
  simulateShot,
  createProjectileSpec,
  directionVector,
  launchSpeed,
  aimFromDrag,
  normalizeShot,
  assertShotInput,
  otherSeat,
} = await import("../src/lib/hillstrike/physics.ts");
const {
  createBattlefield,
  validateBattlefield,
  groundYUnder,
  surfaceYAt,
} = await import("../src/lib/hillstrike/generation.ts");
const {
  BATTLEFIELD_HEIGHT,
  BATTLEFIELD_WIDTH,
  BLOCK_MAX_INTEGRITY,
  MAX_LAUNCH_SPEED,
  CRATER_DEPTH,
  MAX_PATH_POINTS,
  MAX_STRUCTURE_BLOCKS,
  MIN_LAUNCH_SPEED,
  POWER_MAX,
  STRUCTURE_BLOCK_SIZE,
  SUPPORT_TOLERANCE,
  TERRAIN_CARVE_BUDGET,
  TERRAIN_COLUMNS,
  TERRAIN_MAX_SURFACE_Y,
  TERRAIN_MIN_SURFACE_Y,
} = await import("../src/lib/hillstrike/constants.ts");

const SEED = 12345;
const FIELD = createBattlefield(SEED);
/**
 * The same battlefield with the middle tower removed.
 *
 * The tower is a full-height gate, so a spawn-to-spawn line only exists once a
 * lane of it has been shot away. The distance and impact tests below are about
 * the physics of a shot, not about the gate, so they play on the open field.
 */
const OPEN_FIELD = Object.freeze({
  ...FIELD,
  blocks: FIELD.blocks.filter((block) => block.kind !== "tower"),
});
const PROJECTILE = createProjectileSpec();
const clone = (value) => JSON.parse(JSON.stringify(value));

function simulate(shot, overrides = {}) {
  return simulateShot({
    battlefield: FIELD,
    shooterSeat: "player1",
    shot,
    projectile: PROJECTILE,
    ...overrides,
  });
}

/** True when this block rests on the ground or on another block. */
function isSupported(block, blocks, terrain) {
  const bottom = block.y + block.size;
  if (Math.abs(groundYUnder(terrain, block.x, block.size) - bottom) <= SUPPORT_TOLERANCE) {
    return true;
  }
  return blocks.some((other) => {
    if (other.id === block.id) return false;
    const overlap =
      Math.min(block.x + block.size, other.x + other.size) - Math.max(block.x, other.x);
    return overlap >= block.size / 2 && Math.abs(other.y - bottom) <= SUPPORT_TOLERANCE;
  });
}

function assertBattlefieldInvariants(field) {
  const inBounds = field.blocks.every(
    (block) =>
      block.x >= 0 &&
      block.y >= 0 &&
      block.x + block.size <= BATTLEFIELD_WIDTH &&
      block.y + block.size <= BATTLEFIELD_HEIGHT,
  );
  assert.equal(inBounds, true, "blocks stay inside the battlefield");
  assert.ok(field.blocks.length <= MAX_STRUCTURE_BLOCKS);
  assert.deepEqual(validateBattlefield(field), { ok: true });

  for (let a = 0; a < field.blocks.length; a++) {
    for (let b = a + 1; b < field.blocks.length; b++) {
      const first = field.blocks[a];
      const second = field.blocks[b];
      const overlaps =
        first.x < second.x + second.size &&
        second.x < first.x + first.size &&
        first.y < second.y + second.size &&
        second.y < first.y + first.size;
      assert.equal(overlaps, false, "blocks never overlap after a shot");
    }
  }
  for (const block of field.blocks) {
    // Anchored blocks — a base roof and every middle-tower block — are fixed to
    // the map: they never move, never collapse and need no support underneath.
    if (block.kind === "roof" || block.kind === "tower") continue;
    assert.equal(
      isSupported(block, field.blocks, field.terrain),
      true,
      `block ${block.id} must be supported after a shot`,
    );
  }
}

test("angle 0 is right, 90 is up, 180 is left and 270 is down", () => {
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  const right = directionVector(0);
  const up = directionVector(90);
  const left = directionVector(180);

  assert.ok(close(right.x, 1) && close(right.y, 0));
  assert.ok(close(up.x, 0) && close(up.y, -1));
  assert.ok(close(left.x, -1) && close(left.y, 0));
  assert.ok(close(directionVector(270).y, 1));
});

test("power maps monotonically onto the shared launch speed", () => {
  assert.equal(launchSpeed(0), MIN_LAUNCH_SPEED);
  assert.equal(launchSpeed(POWER_MAX), MAX_LAUNCH_SPEED);
  assert.ok(launchSpeed(50) > launchSpeed(25));
  assert.ok(launchSpeed(25) > launchSpeed(0));
  // Clamped, never extrapolated.
  assert.equal(launchSpeed(-50), MIN_LAUNCH_SPEED);
  assert.equal(launchSpeed(500), MAX_LAUNCH_SPEED);
});

test("the projectile spec is one frozen spec, identical for both seats", () => {
  const second = createProjectileSpec();
  assert.deepEqual(PROJECTILE, second);
  assert.equal(Object.isFrozen(PROJECTILE), true);
  assert.equal("seat" in PROJECTILE, false, "no per-seat parameters exist");
});

test("a drag becomes the opposite launch direction and a bounded power", () => {
  const shot = aimFromDrag({ fromX: 200, fromY: 400, toX: 120, toY: 480, maxPull: 150 });
  assert.ok(shot);
  assert.ok(Math.abs(shot.angleDeg - 45) < 1e-9, "pull down-left launches up-right");
  assert.equal(shot.power, 75);

  assert.equal(aimFromDrag({ fromX: 0, fromY: 0, toX: 1, toY: 1 }), null, "a tap is not a shot");
  assert.throws(() => aimFromDrag({ fromX: Number.NaN, fromY: 0, toX: 1, toY: 1 }), /fromX/);
  assert.throws(
    () => aimFromDrag({ fromX: 0, fromY: 0, toX: 10, toY: 10, maxPull: 0 }),
    /maxPull/,
  );
});

test("normalizeShot repairs a UI aim, assertShotInput refuses a bad one", () => {
  assert.deepEqual(normalizeShot({ angleDeg: -45, power: 150 }), { angleDeg: 315, power: 100 });
  assert.deepEqual(normalizeShot({ angleDeg: 725, power: 50.6 }), { angleDeg: 5, power: 51 });

  assert.deepEqual(assertShotInput({ angleDeg: 12, power: 80 }), { angleDeg: 12, power: 80 });
  assert.throws(() => assertShotInput({ angleDeg: 360, power: 10 }), RangeError);
  assert.throws(() => assertShotInput({ angleDeg: 10, power: 10.5 }), RangeError);
  assert.throws(() => assertShotInput({ angleDeg: Number.NaN, power: 10 }), TypeError);
  assert.throws(() => assertShotInput({ angleDeg: 10, power: Number.POSITIVE_INFINITY }), TypeError);
  assert.throws(() => assertShotInput(null), TypeError);
});

test("the simulator refuses invalid battlefields, seats and shots", () => {
  assert.throws(
    () => simulateShot({ battlefield: { ...FIELD, width: 10 }, shooterSeat: "player1", shot: { angleDeg: 45, power: 50 } }),
    /invalid battlefield/,
  );
  assert.throws(
    () => simulateShot({ battlefield: FIELD, shooterSeat: "player3", shot: { angleDeg: 45, power: 50 } }),
    /invalid shooter seat/,
  );
  assert.throws(
    () => simulateShot({ battlefield: FIELD, shooterSeat: "player1", shot: { angleDeg: 400, power: 50 } }),
    RangeError,
  );
});

test("the same shot always resolves byte-identically", () => {
  const shot = { angleDeg: 60, power: 90 };
  const first = simulate(shot);
  const second = simulate(shot);

  assert.deepEqual(clone(first), clone(second));
  assert.notDeepEqual(
    clone(first.path),
    clone(simulate(shot, { shooterSeat: "player2" }).path),
    "the other seat is a different shot, not a mirrored result",
  );
});

test("a different battlefield seed produces a different battlefield", () => {
  const a = createBattlefield(1);
  const b = createBattlefield(2);
  assert.notDeepEqual(a.terrain, b.terrain);
});

test("the generator rejects every kind of corrupted battlefield", () => {
  const corruptions = [
    ["wrong width", { ...FIELD, width: 10 }],
    ["wrong height", { ...FIELD, height: 10 }],
    ["short terrain", { ...FIELD, terrain: FIELD.terrain.slice(0, 10) }],
    ["terrain too high", { ...FIELD, terrain: FIELD.terrain.map((y, i) => (i === 7 ? 100 : y)) }],
    ["terrain too low", { ...FIELD, terrain: FIELD.terrain.map((y, i) => (i === 7 ? 900 : y)) }],
    ["fractional terrain", { ...FIELD, terrain: FIELD.terrain.map((y, i) => (i === 7 ? y + 0.5 : y)) }],
    ["bad seed", { ...FIELD, seed: -1 }],
    ["bad version", { ...FIELD, version: 0 }],
    ["duplicate block id", { ...FIELD, blocks: FIELD.blocks.map((b, i) => (i === 1 ? { ...b, id: FIELD.blocks[0].id } : b)) }],
    ["overlapping blocks", { ...FIELD, blocks: FIELD.blocks.map((b, i) => (i === 1 ? { ...b, x: FIELD.blocks[0].x, y: FIELD.blocks[0].y } : b)) }],
    ["wrong block size", { ...FIELD, blocks: FIELD.blocks.map((b, i) => (i === 0 ? { ...b, size: 4 } : b)) }],
    ["zero integrity", { ...FIELD, blocks: FIELD.blocks.map((b, i) => (i === 0 ? { ...b, integrity: 0 } : b)) }],
    ["excess integrity", { ...FIELD, blocks: FIELD.blocks.map((b, i) => (i === 0 ? { ...b, integrity: BLOCK_MAX_INTEGRITY + 1 } : b)) }],
    ["block out of bounds", { ...FIELD, blocks: FIELD.blocks.map((b, i) => (i === 0 ? { ...b, x: BATTLEFIELD_WIDTH - 1 } : b)) }],
    ["player off the ground", { ...FIELD, players: { ...FIELD.players, player1: { ...FIELD.players.player1, y: FIELD.players.player1.y + 3 } } }],
    ["players too close", { ...FIELD, players: { ...FIELD.players, player2: { ...FIELD.players.player2, x: FIELD.players.player1.x } } }],
    ["too many blocks", { ...FIELD, blocks: new Array(MAX_STRUCTURE_BLOCKS + 1).fill(FIELD.blocks[0]) }],
    ["bad block kind", { ...FIELD, blocks: FIELD.blocks.map((b, i) => (i === 0 ? { ...b, kind: "lava" } : b)) }],
    ["bad pickup kind", { ...FIELD, pickups: FIELD.pickups.map((p, i) => (i === 0 ? { ...p, kind: "laser" } : p)) }],
    ["pickup out of bounds", { ...FIELD, pickups: FIELD.pickups.map((p, i) => (i === 0 ? { ...p, x: BATTLEFIELD_WIDTH + 5 } : p)) }],
    ["duplicate pickup id", { ...FIELD, pickups: FIELD.pickups.map((p, i) => (i === 1 ? { ...p, id: FIELD.pickups[0].id } : p)) }],
    ["not an object", null],
  ];

  for (const [label, field] of corruptions) {
    const verdict = validateBattlefield(field);
    assert.equal(verdict.ok, false, `${label} must be rejected`);
  }
});

test("every launched shot terminates inside the fixed-step limits", () => {
  for (const shot of [
    { angleDeg: 0, power: 100 },
    { angleDeg: 45, power: 100 },
    { angleDeg: 90, power: 100 },
    { angleDeg: 135, power: 60 },
    { angleDeg: 270, power: 100 },
  ]) {
    const simulation = simulate(shot);
    assert.ok(simulation.impact.tick <= PROJECTILE.maxTicks);
    assert.ok(simulation.ticks <= PROJECTILE.maxTicks);
    assert.ok(simulation.path.length <= MAX_PATH_POINTS);
    assert.ok(["player", "block", "terrain", "out-of-bounds", "timeout"].includes(simulation.impact.kind));
  }
});

test("a shot that never lands is stopped by the tick cap and does no damage", () => {
  const simulation = simulateShot({
    battlefield: FIELD,
    shooterSeat: "player1",
    // Backwards and up: after one gravity-free tick it is still inside the map
    // and has met nothing, so only the tick cap can end it.
    shot: { angleDeg: 135, power: 100 },
    projectile: { ...PROJECTILE, maxTicks: 1, gravity: 0 },
  });

  assert.equal(simulation.impact.kind, "timeout");
  assert.equal(simulation.impact.tick, 1);
  assert.deepEqual(simulation.battlefield.terrain, FIELD.terrain);
  assert.deepEqual(simulation.battlefield.blocks, FIELD.blocks);
  assert.equal(simulation.events.some((event) => event.type === "player-hit"), false);
});

test("the projectile never tunnels through the ground", () => {
  for (const angleDeg of [10, 25, 45, 70, 110, 135, 160]) {
    const simulation = simulate({ angleDeg, power: 100 });
    for (const point of simulation.path) {
      // The ground is a heightmap of 5-unit STEPS, so a contact can land exactly
      // on a vertical face between two columns. Both neighbours are legitimate
      // ground at that x, so the point only has to be above the lower of them.
      const surface = Math.max(
        surfaceYAt(FIELD.terrain, point.x),
        surfaceYAt(FIELD.terrain, point.x - 1e-3),
      );
      assert.ok(
        point.y <= surface + 1e-6,
        `path point (${point.x.toFixed(1)}, ${point.y.toFixed(1)}) must stay above the terrain`,
      );
    }
  }
});

test("a high-speed shot is stopped by a block instead of passing through it", () => {
  // Straight up into the tank's own base roof: the closest, hardest contact in
  // the game, and the one a tunnelling bug would fly straight through.
  const hit = simulate({ angleDeg: 90, power: 100 });

  assert.equal(hit.impact.kind, "block");
  assert.ok(hit.impact.tick < 20, "the contact happens early, not after a fly-through");
  const roof = FIELD.blocks.find((block) => block.id === hit.impact.blockId);
  assert.equal(roof.kind, "roof");
  assert.equal(
    hit.events.some((event) => event.type === "block-damaged" || event.type === "block-destroyed"),
    false,
    "an indestructible roof is not damaged by the hit it stops",
  );
});

test("a tower block takes two contacts to break, however long the shot was", () => {
  const towerIds = new Set(
    FIELD.blocks.filter((block) => block.kind === "tower").map((block) => block.id),
  );

  // Find a line that reaches the middle tower from the spawn.
  let shot = null;
  let first = null;
  for (let angleDeg = 4; angleDeg <= 86 && !first; angleDeg += 1) {
    const simulation = simulateShot({
      battlefield: FIELD,
      shooterSeat: "player1",
      shot: { angleDeg, power: 100 },
      projectile: PROJECTILE,
    });
    if (simulation.impact.kind === "block" && towerIds.has(simulation.impact.blockId)) {
      shot = { angleDeg, power: 100 };
      first = simulation;
    }
  }
  assert.ok(first, "the tower is reachable from the spawn");
  assert.ok(first.distance > 800, "the tower is a long shot from the spawn");

  const id = first.impact.blockId;
  assert.ok(
    first.events.some((event) => event.type === "block-damaged" && event.blockId === id),
    "the first contact only damages the block",
  );
  assert.equal(
    first.battlefield.blocks.some((block) => block.id === id),
    true,
    "and leaves it standing",
  );

  // The second contact breaks it, however far the shell flew.
  const again = simulateShot({
    battlefield: first.battlefield,
    shooterSeat: "player1",
    shot,
    projectile: PROJECTILE,
  });
  assert.equal(again.impact.blockId, id, "the same block is struck again");
  assert.ok(
    again.events.some((event) => event.type === "block-destroyed" && event.blockId === id),
    "two contacts destroy a tower block",
  );
  assert.equal(
    again.battlefield.blocks.some((block) => block.id === id),
    false,
    "the block is gone",
  );
});

test("a crater is the same size whatever the flight distance", () => {
  // A short flat shot and a long lob: both land on terrain, and both must carve
  // the SAME depth at the impact column. Distance is a dial for tank damage only.
  const flat = simulate({ angleDeg: 12, power: 100 }, { battlefield: OPEN_FIELD });
  assert.equal(flat.impact.kind, "terrain");

  let lob = null;
  for (const power of [100, 80, 60]) {
    for (let angleDeg = 30; angleDeg <= 75 && !lob; angleDeg += 1) {
      const candidate = simulate({ angleDeg, power }, { battlefield: OPEN_FIELD });
      if (candidate.impact.kind === "terrain" && candidate.distance > flat.distance + 800) {
        lob = candidate;
      }
    }
  }
  assert.ok(lob, "a long terrain shot must be reachable from the spawn");

  const column = (x) => Math.min(TERRAIN_COLUMNS - 1, Math.max(0, Math.floor(x / 5)));
  for (const simulation of [flat, lob]) {
    const index = column(simulation.impact.x);
    const room = TERRAIN_MAX_SURFACE_Y - OPEN_FIELD.terrain[index];
    const carved = simulation.battlefield.terrain[index] - OPEN_FIELD.terrain[index];
    assert.equal(carved, Math.min(CRATER_DEPTH, room), "the crater depth is fixed");
  }
});

test("a direct player hit arrives as a player contact, not a pass-through", () => {
  // The map is mirrored and the tower is the only thing in the middle: on the
  // open field a fine sweep finds the line the tower would have swallowed.
  let hit = null;
  for (let power = 100; power >= 60 && !hit; power -= 5) {
    for (let angleDeg = 0; angleDeg < 180 && !hit; angleDeg += 0.5) {
      const simulation = simulate(
        { angleDeg, power },
        { shooterSeat: "player1", battlefield: OPEN_FIELD },
      );
      if (simulation.impact.kind === "player") hit = simulation;
    }
  }

  assert.ok(hit, "the enemy tank is reachable at maximum power");
  assert.equal(hit.impact.target, "player2");
  assert.equal(otherSeat("player1"), "player2");
  assert.deepEqual(
    hit.battlefield.terrain,
    OPEN_FIELD.terrain,
    "a direct hit carves nothing, so no life can be lost to terrain",
  );
  assert.deepEqual(hit.battlefield.blocks, OPEN_FIELD.blocks);
});

test("terrain deformation is integer, bounded and deterministic", () => {
  let terrainShot = null;
  for (let angleDeg = 20; angleDeg < 100 && !terrainShot; angleDeg += 5) {
    const simulation = simulate({ angleDeg, power: 100 });
    if (simulation.impact.kind === "terrain") terrainShot = simulation;
  }
  assert.ok(terrainShot, "a terrain impact must be reachable");

  const after = terrainShot.battlefield.terrain;
  assert.equal(after.length, TERRAIN_COLUMNS);
  let carved = 0;
  for (let column = 0; column < after.length; column++) {
    assert.equal(Number.isInteger(after[column]), true, "heights stay integers");
    assert.ok(after[column] >= TERRAIN_MIN_SURFACE_Y && after[column] <= TERRAIN_MAX_SURFACE_Y);
    assert.ok(after[column] >= FIELD.terrain[column], "the ground is only ever removed, never raised");
    carved += after[column] - FIELD.terrain[column];
  }
  assert.ok(carved > 0, "a terrain impact does carve");
  assert.ok(carved <= TERRAIN_CARVE_BUDGET, "one shot can never exceed the carve budget");

  // Deforming the ground twice from the same starting battlefield is stable.
  const repeat = simulateShot({
    battlefield: FIELD,
    shooterSeat: "player1",
    shot: { angleDeg: 20, power: 100 },
    projectile: PROJECTILE,
  });
  const firstOfSameShot = simulateShot({
    battlefield: FIELD,
    shooterSeat: "player1",
    shot: { angleDeg: 20, power: 100 },
    projectile: PROJECTILE,
  });
  assert.deepEqual(clone(repeat.battlefield), clone(firstOfSameShot.battlefield));
});

test("the tower is anchored: it is damaged in place and never collapses", () => {
  const towerIds = new Set(
    FIELD.blocks.filter((block) => block.kind === "tower").map((block) => block.id),
  );
  const initial = new Map(FIELD.blocks.map((block) => [block.id, block]));

  // A line that meets the tower (the angle is discovered, not hard-coded).
  let shot = null;
  for (let angleDeg = 4; angleDeg <= 86 && !shot; angleDeg += 1) {
    const impact = simulateShot({
      battlefield: FIELD,
      shooterSeat: "player1",
      shot: { angleDeg, power: 100 },
      projectile: PROJECTILE,
    }).impact;
    if (impact.kind === "block" && towerIds.has(impact.blockId)) {
      shot = { angleDeg, power: 100 };
    }
  }
  assert.ok(shot, "the tower is reachable");

  let field = FIELD;
  let brokeSomething = false;
  for (let index = 0; index < 4; index++) {
    const simulation = simulateShot({
      battlefield: field,
      shooterSeat: "player1",
      shot,
      projectile: PROJECTILE,
    });
    field = simulation.battlefield;
    assert.equal(
      simulation.events.some((event) => event.type === "collapse"),
      false,
      "an anchored tower never collapses",
    );
    if (simulation.events.some((event) => event.type === "block-destroyed")) {
      brokeSomething = true;
    }
  }
  assert.equal(brokeSomething, true, "the shots do break the tower down");

  assertBattlefieldInvariants(field);
  // Every surviving tower block is exactly where it started.
  for (const block of field.blocks) {
    if (block.kind !== "tower") continue;
    const original = initial.get(block.id);
    assert.ok(original, "tower blocks keep their identity");
    assert.equal(block.x, original.x, "a tower block never slides sideways");
    assert.equal(block.y, original.y, "a tower block never falls into a hole");
  }
});

test("the ground under a tower can be carved without costing a life", () => {
  // Physics owns no lives; this pins that its battlefield result carries the
  // players down with the ground instead of inventing a hit.
  let field = OPEN_FIELD;
  let sawCrater = false;

  // A flat arc that lands on the ground ahead (found, not hard-coded).
  let shot = null;
  for (let angleDeg = 10; angleDeg <= 80 && !shot; angleDeg += 1) {
    const impact = simulateShot({
      battlefield: OPEN_FIELD,
      shooterSeat: "player1",
      shot: { angleDeg, power: 80 },
      projectile: PROJECTILE,
    }).impact;
    if (impact.kind === "terrain") shot = { angleDeg, power: 80 };
  }
  assert.ok(shot, "a terrain shot exists");

  for (let shotIndex = 0; shotIndex < 4; shotIndex++) {
    const simulation = simulateShot({
      battlefield: field,
      shooterSeat: "player1",
      shot,
      projectile: PROJECTILE,
    });
    field = simulation.battlefield;
    if (simulation.events.some((event) => event.type === "terrain-carved")) sawCrater = true;
    for (const seat of ["player1", "player2"]) {
      assert.equal(field.players[seat].y, surfaceYAt(field.terrain, field.players[seat].x));
    }
    assert.equal(simulation.events.some((event) => event.type === "player-hit"), false);
  }
  assert.equal(sawCrater, true);
});

test("a settled battlefield is still a valid, replayable battlefield", () => {
  const simulation = simulate({ angleDeg: 70, power: 100 });
  assert.deepEqual(validateBattlefield(simulation.battlefield), { ok: true });

  const replay = simulateShot({
    battlefield: simulation.battlefield,
    shooterSeat: "player2",
    shot: { angleDeg: 110, power: 70 },
    projectile: PROJECTILE,
  });
  assert.deepEqual(validateBattlefield(replay.battlefield), { ok: true });
});

test("path recording keeps its endpoints and the impact point", () => {
  const simulation = simulate({ angleDeg: 45, power: 100 });
  const first = simulation.path[0];
  const last = simulation.path[simulation.path.length - 1];

  assert.equal(Number.isFinite(first.x) && Number.isFinite(first.y), true);
  assert.equal(last.x, simulation.impact.x);
  assert.equal(last.y, simulation.impact.y);
  assert.ok(simulation.path.length >= 2);
});
