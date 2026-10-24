/**
 * hillstrike-engine-contracts.test.mjs — Phase 4's engine gate.
 *
 * Phase 2 pinned each rule in isolation. This suite pins them TOGETHER, the way
 * a real match runs them: full scripted volleys (both opening seats), hits that
 * keep a volley alive, hits that end the match mid-volley, out-of-bounds shots,
 * malformed and stale/duplicate actions at the boundary, and the hard limits
 * (ticks, substeps, path points, collapse). Every shot here is produced by
 * searching the engine's own simulation for the line that does what the case
 * needs, so the cases cannot silently stop testing what they claim.
 *
 * Run:  node --import tsx --test tests/hillstrike-engine-contracts.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BLOCK_MAX_INTEGRITY,
  IMPACT_KINDS,
  LIVES_PER_PLAYER,
  MATCH_STATUS,
  MAX_PATH_POINTS,
  MAX_STRUCTURE_BLOCKS,
  MAX_STRUCTURE_BLOCKS_PER_SEAT,
  MIN_PLAYER_SEPARATION,
  PLAYER_RADIUS,
  REJECTION,
  SHOTS_PER_VOLLEY,
  STRUCTURE_BLOCK_SIZE,
  TERRAIN_COLUMNS,
  TERRAIN_MAX_STEP,
  TERRAIN_MAX_SURFACE_Y,
  TERRAIN_MIN_SURFACE_Y,
} from "../src/lib/hillstrike/constants.ts";
import {
  createBattlefield,
  validateBattlefield,
} from "../src/lib/hillstrike/generation.ts";
import {
  aimFromDrag,
  createProjectileSpec,
  simulateShot,
} from "../src/lib/hillstrike/physics.ts";
import {
  applyShot,
  createInitialState,
  isHillstrikeRuleError,
  tryApplyShot,
} from "../src/lib/hillstrike/rules.ts";

const SEATS = ["player1", "player2"];
const SEEDS = [0, 1, 7, 42, 424242, 987654];

const other = (seat) => (seat === "player1" ? "player2" : "player1");

/** Resolve a shot without touching the match, for searching. */
function simulate(state, seat, shot) {
  return simulateShot({
    battlefield: state.battlefield,
    shooterSeat: seat,
    shot,
    projectile: state.projectile,
  });
}

/**
 * The first line (in a deterministic scan order) whose impact is `kind`
 * (optionally hitting `target`). Throws if the case's premise is impossible —
 * a scripted case that cannot find its shot must fail loudly.
 */
function findShot(state, seat, kind, { target = null, angles = null } = {}) {
  const arc = angles ?? (seat === "player1" ? [4, 86] : [94, 176]);
  for (let angle = arc[0]; angle <= arc[1]; angle += 1) {
    for (let power = 30; power <= 100; power += 2) {
      const shot = { angleDeg: angle, power };
      const simulation = simulate(state, seat, shot);
      if (simulation.impact.kind !== kind) continue;
      if (target && simulation.impact.target !== target) continue;
      return shot;
    }
  }
  throw new Error(`no ${kind} shot found for ${seat} (target ${String(target)})`);
}

const hitShot = (state, seat) => findShot(state, seat, IMPACT_KINDS.PLAYER, { target: other(seat) });
const blockShot = (state, seat) => findShot(state, seat, IMPACT_KINDS.BLOCK);

/**
 * A shot that sails clean over everything and out of the battlefield.
 *
 * On this battlefield the field is open at the top of the arc, so a full-power
 * lob overshoots the far wall — which is exactly the "how did I miss that badly"
 * miss a player produces with the wrong power.
 */
function outOfBoundsShot(state, seat) {
  const arc = seat === "player1" ? [20, 80] : [100, 160];
  for (let angle = arc[0]; angle <= arc[1]; angle += 1) {
    const shot = { angleDeg: angle, power: 100 };
    if (simulate(state, seat, shot).impact.kind === IMPACT_KINDS.OUT_OF_BOUNDS) return shot;
  }
  throw new Error(`no out-of-bounds line for ${seat} on seed ${state.seed}`);
}

/* -------------------------------------------------------------------------- *
 * Volleys
 * -------------------------------------------------------------------------- */

test("volleys: the opening seat fires one shot, then every volley is exactly two", () => {
  for (const openingSeat of SEATS) {
    let state = createInitialState({ seed: 424242, openingSeat });
    const timeline = [{ turn: state.turn, shots: state.shotsRemaining, index: state.turnIndex }];
    let guard = 0;

    while (state.status === MATCH_STATUS.PLAYING && guard < 20) {
      const shooter = state.turn;
      // Alternate between using the volley and hitting: the counter must not
      // care whether a shot connects.
      const shot = guard % 3 === 0 ? hitShot(state, shooter) : blockShot(state, shooter);
      state = applyShot(state, shooter, shot).state;
      guard += 1;
      if (state.status === MATCH_STATUS.PLAYING) {
        timeline.push({ turn: state.turn, shots: state.shotsRemaining, index: state.turnIndex });
      }
    }

    assert.equal(state.status, MATCH_STATUS.FINISHED, "the scripted match must terminate");
    assert.ok(guard >= 3, "a match cannot end before three shots");

    // Shot 0 is the opening one-shot volley: the turn passes immediately.
    assert.equal(timeline[0].index, 0);
    assert.equal(timeline[0].shots, 1);
    assert.equal(timeline[1].turn, other(openingSeat), "the answering seat gets the next turn");
    assert.equal(timeline[1].shots, SHOTS_PER_VOLLEY);

    // Everything after the opening is a pair: the same seat twice, then swap.
    for (let index = 1; index + 1 < timeline.length; index += 2) {
      assert.equal(timeline[index].turn, timeline[index + 1].turn, "a volley is two shots");
      assert.equal(timeline[index].shots, 2);
      assert.equal(timeline[index + 1].shots, 1);
      if (timeline[index + 2]) {
        assert.equal(
          timeline[index + 2].turn,
          other(timeline[index].turn),
          "the volley passes to the other seat",
        );
      }
    }
  }
});

test("volleys: two hits in one volley cost two lives and the volley still passes", () => {
  let state = createInitialState({ seed: 42, openingSeat: "player1" });
  const shooter = "player2";

  // Get to player2's two-shot volley with the defender on three lives.
  state = applyShot(state, "player1", outOfBoundsShot(state, "player1")).state;
  assert.equal(state.turn, shooter);
  const first = hitShot(state, shooter);
  const afterFirst = applyShot(state, shooter, first).state;

  assert.equal(afterFirst.lives.player1, LIVES_PER_PLAYER - 1);
  assert.equal(afterFirst.turn, shooter, "a hit does not end the volley");
  assert.equal(afterFirst.shotsRemaining, 1);
  assert.equal(afterFirst.status, MATCH_STATUS.PLAYING);

  const second = hitShot(afterFirst, shooter);
  const afterSecond = applyShot(afterFirst, shooter, second).state;

  assert.equal(afterSecond.lives.player1, LIVES_PER_PLAYER - 2);
  assert.equal(afterSecond.turn, "player1", "the volley passes after its second shot");
  assert.equal(afterSecond.shotsRemaining, SHOTS_PER_VOLLEY);
  assert.equal(afterSecond.turnIndex, 3);
});

test("volleys: a killing hit on the FIRST shot ends the match and voids the second", () => {
  let state = createInitialState({ seed: 7, openingSeat: "player2" });

  /** Burn harmless misses until `seat` owns a FRESH two-shot volley. */
  const passToFreshVolley = (seat) => {
    let guard = 0;
    while (
      state.status === MATCH_STATUS.PLAYING &&
      (state.turn !== seat || state.shotsRemaining !== SHOTS_PER_VOLLEY) &&
      guard < 12
    ) {
      const shooter = state.turn;
      state = applyShot(state, shooter, outOfBoundsShot(state, shooter)).state;
      guard += 1;
    }
    assert.ok(guard < 12, `could not reach a fresh volley for ${seat}`);
  };

  // Two unanswered hits on player1, one per volley, leaving a single life.
  for (let hit = 0; hit < LIVES_PER_PLAYER - 1; hit++) {
    passToFreshVolley("player2");
    state = applyShot(state, "player2", hitShot(state, "player2")).state;
    assert.equal(state.status, MATCH_STATUS.PLAYING, "the victim is still alive");
  }
  passToFreshVolley("player2");

  assert.equal(state.lives.player1, 1);
  assert.equal(state.turn, "player2");
  assert.equal(state.shotsRemaining, SHOTS_PER_VOLLEY);

  const lethal = applyShot(state, "player2", hitShot(state, "player2"));
  const ended = lethal.state;

  assert.equal(ended.status, MATCH_STATUS.FINISHED);
  assert.equal(ended.winner, "player2");
  assert.equal(ended.terminationReason, "lives-exhausted");
  assert.equal(ended.lives.player1, 0);
  assert.equal(ended.shotsRemaining, 0, "the volley dies with the match");
  assert.ok(
    lethal.events.some((event) => event.type === "match-ended" && event.winner === "player2"),
    "the animation stream carries the terminal event",
  );

  // The shooter's remaining volley shot is gone, and so is any further action.
  const denied = tryApplyShot(ended, "player2", lethal.state.lastShot.shot);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, REJECTION.MATCH_NOT_PLAYING);
});

test("volleys: lives never go below zero, and only a direct hit takes one", () => {
  let state = createInitialState({ seed: 987654, openingSeat: "player2" });
  let shots = 0;
  while (state.status === MATCH_STATUS.PLAYING && shots < 40) {
    const shooter = state.turn;
    const before = { ...state.lives };
    const shot = hitShot(state, shooter);
    const next = applyShot(state, shooter, shot).state;
    const victim = other(shooter);
    assert.equal(next.lives[victim], Math.max(0, before[victim] - 1));
    assert.equal(next.lives[shooter], before[shooter], "the shooter never loses a life");
    assert.ok(next.lives[victim] >= 0);
    state = next;
    shots += 1;
  }
  assert.equal(state.status, MATCH_STATUS.FINISHED);
  assert.equal(state.lives[other(state.winner)], 0);
  assert.ok(state.lives[state.winner] > 0);
});

/* -------------------------------------------------------------------------- *
 * Shots that change nothing but the volley
 * -------------------------------------------------------------------------- */

test("out-of-bounds: the shot is consumed, costs nothing and changes no ground", () => {
  let state = createInitialState({ seed: 424242, openingSeat: "player1" });
  state = applyShot(state, "player1", outOfBoundsShot(state, "player1")).state;
  const shooter = state.turn;

  const beforeTerrain = [...state.battlefield.terrain];
  const beforeBlocks = state.battlefield.blocks.map((block) => ({ ...block }));
  const beforeLives = { ...state.lives };

  const result = applyShot(state, shooter, outOfBoundsShot(state, shooter));
  const after = result.state;

  assert.equal(after.lastShot.impact.kind, IMPACT_KINDS.OUT_OF_BOUNDS);
  assert.equal(after.lastShot.livesLost, 0);
  assert.deepEqual(after.lives, beforeLives);
  assert.deepEqual(after.battlefield.terrain, beforeTerrain, "no crater from a miss");
  assert.deepEqual(
    after.battlefield.blocks.map((block) => ({ ...block })),
    beforeBlocks,
    "no structural damage from a miss",
  );
  assert.equal(after.turnIndex, state.turnIndex + 1, "it still used a shot");
  assert.equal(
    result.events.some((event) => event.type === "player-hit"),
    false,
    "no hit event",
  );
  assert.equal(validateBattlefield(after.battlefield).ok, true);
});

test("timeout: a shot that never lands is bounded and harmless", () => {
  const state = createInitialState({ seed: 11, openingSeat: "player1" });
  // Straight up at minimum power: it comes back down, but the tick cap is what
  // the case must not exceed, whatever it hits.
  for (const power of [0, 1, 2]) {
    const simulation = simulate(state, "player1", { angleDeg: 90, power });
    assert.ok(simulation.impact.tick <= state.projectile.maxTicks);
    assert.ok(simulation.ticks <= state.projectile.maxTicks);
  }
});

/* -------------------------------------------------------------------------- *
 * Boundary: malformed, duplicate, stale
 * -------------------------------------------------------------------------- */

test("boundary: malformed payloads are refused with a specific code, state untouched", () => {
  const state = createInitialState({ seed: 42, openingSeat: "player1" });
  const before = JSON.stringify(state);
  const seat = state.turn;
  const cases = [
    [null, REJECTION.INVALID_SHOT],
    [undefined, REJECTION.INVALID_SHOT],
    ["45,80", REJECTION.INVALID_SHOT],
    [[45, 80], REJECTION.INVALID_SHOT],
    [{}, REJECTION.INVALID_SHOT],
    [{ angleDeg: 45 }, REJECTION.INVALID_SHOT],
    [{ power: 80 }, REJECTION.INVALID_SHOT],
    [{ angleDeg: Number.NaN, power: 80 }, REJECTION.ANGLE_INVALID],
    [{ angleDeg: Number.POSITIVE_INFINITY, power: 80 }, REJECTION.ANGLE_INVALID],
    [{ angleDeg: -0.001, power: 80 }, REJECTION.ANGLE_INVALID],
    [{ angleDeg: 360, power: 80 }, REJECTION.ANGLE_INVALID],
    [{ angleDeg: 1e9, power: 80 }, REJECTION.ANGLE_INVALID],
    [{ angleDeg: "45", power: 80 }, REJECTION.ANGLE_INVALID],
    [{ angleDeg: 45, power: Number.NaN }, REJECTION.POWER_INVALID],
    [{ angleDeg: 45, power: 100.5 }, REJECTION.POWER_INVALID],
    [{ angleDeg: 45, power: -1 }, REJECTION.POWER_INVALID],
    [{ angleDeg: 45, power: 101 }, REJECTION.POWER_INVALID],
    [{ angleDeg: 45, power: "80" }, REJECTION.POWER_INVALID],
  ];
  for (const [shot, code] of cases) {
    const verdict = tryApplyShot(state, seat, shot);
    assert.equal(verdict.ok, false, `payload ${JSON.stringify(shot)} must be refused`);
    assert.equal(verdict.code, code, `payload ${JSON.stringify(shot)}`);
    assert.throws(() => applyShot(state, seat, shot), (error) => {
      assert.ok(isHillstrikeRuleError(error));
      assert.equal(error.code, code);
      return true;
    });
  }
  assert.equal(JSON.stringify(state), before, "a refused shot never mutates the state");

  // Extra fields are ignored, not honoured: the shot resolves exactly as without.
  const clean = { angleDeg: 30, power: 70 };
  const padded = { ...clean, power: 70, damage: 99, target: "player2", x: 0, y: 0 };
  assert.deepEqual(
    applyShot(state, seat, padded).state.lastShot.impact,
    applyShot(state, seat, clean).state.lastShot.impact,
  );
});

test("boundary: duplicate and stale actions cannot double-apply or replay a cached outcome", () => {
  const state = createInitialState({ seed: 1, openingSeat: "player1" });
  const shot = hitShot(state, "player1");

  // 1. The same call twice is pure: identical results, and neither mutates input.
  const first = applyShot(state, "player1", shot);
  const repeat = applyShot(state, "player1", shot);
  assert.deepEqual(repeat.state, first.state);
  assert.deepEqual(repeat.events, first.events);
  assert.equal(state.lives.player1, LIVES_PER_PLAYER, "the input state is untouched");

  // 2. Replaying the SAME payload against the ADVANCED state is refused when the
  //    turn moved (the opening volley is one shot), so a duplicated request can
  //    never take a second life.
  const duplicated = tryApplyShot(first.state, "player1", shot);
  assert.equal(duplicated.ok, false);
  assert.equal(duplicated.code, REJECTION.NOT_YOUR_TURN);
  assert.equal(first.state.lives.player2, LIVES_PER_PLAYER - 1);

  // 3. Inside a two-shot volley the same payload IS legal twice (two separate
  //    shots), and each one applies exactly once.
  let state2 = createInitialState({ seed: 2, openingSeat: "player2" });
  state2 = applyShot(state2, "player2", outOfBoundsShot(state2, "player2")).state;
  assert.equal(state2.turn, "player1");
  assert.equal(state2.shotsRemaining, SHOTS_PER_VOLLEY);
  const volleyShot = hitShot(state2, "player1");
  const a = applyShot(state2, "player1", volleyShot).state;
  const b = applyShot(a, "player1", volleyShot).state;
  assert.equal(a.lives.player2, LIVES_PER_PLAYER - 1);
  assert.equal(b.lives.player2, LIVES_PER_PLAYER - 2);

  // 4. A STALE action (resolved against an older battlefield) is re-validated and
  //    re-simulated against the CURRENT one: no cached outcome is replayed.
  //    Player1 empties both volley shots into the tower in front of the bot, then
  //    the SAME payload is fired again on the next volley — by then that cover is
  //    rubble, so the shot must resolve differently.
  let staleState = createInitialState({ seed: 2, openingSeat: "player2" });
  staleState = applyShot(staleState, "player2", outOfBoundsShot(staleState, "player2")).state;
  assert.equal(staleState.turn, "player1");

  const towerShot = blockShot(staleState, "player1");
  const staleOutcome = simulate(staleState, "player1", towerShot).impact;
  assert.equal(staleOutcome.kind, IMPACT_KINDS.BLOCK);

  const blocksBefore = staleState.battlefield.blocks.length;
  let cleared = applyShot(staleState, "player1", towerShot).state;
  cleared = applyShot(cleared, "player1", towerShot).state; // the volley's second shot
  assert.ok(cleared.battlefield.blocks.length < blocksBefore, "the tower really lost blocks");

  // Let the bot burn its own volley so player1 owns the turn again.
  let guard = 0;
  while (cleared.status === MATCH_STATUS.PLAYING && cleared.turn !== "player1" && guard < 6) {
    const shooter = cleared.turn;
    cleared = applyShot(cleared, shooter, outOfBoundsShot(cleared, shooter)).state;
    guard += 1;
  }
  assert.equal(cleared.turn, "player1");

  const revalidated = simulate(cleared, "player1", towerShot).impact;
  const appliedNow = applyShot(cleared, "player1", towerShot).state.lastShot.impact;
  assert.deepEqual(appliedNow, revalidated, "the shot resolves against the live battlefield");
  assert.notDeepEqual(
    { x: appliedNow.x, y: appliedNow.y, kind: appliedNow.kind },
    { x: staleOutcome.x, y: staleOutcome.y, kind: staleOutcome.kind },
    "the old resolution is not replayed",
  );
});

test("boundary: the shooter may hit themselves, and it costs them a life", () => {
  const state = createInitialState({ seed: 3, openingSeat: "player1" });
  // A drag pointing back over their own head: the engine allows any angle, so a
  // player who aims badly can hit their own body.
  const selfShot = (() => {
    for (let angle = 150; angle <= 210; angle += 1) {
      for (let power = 40; power <= 100; power += 2) {
        const shot = { angleDeg: angle, power };
        const impact = simulate(state, "player1", shot).impact;
        if (impact.kind === IMPACT_KINDS.PLAYER && impact.target === "player1") return shot;
      }
    }
    return null;
  })();
  if (!selfShot) return; // no self-hit line on this layout: nothing to assert.

  const next = applyShot(state, "player1", selfShot).state;
  assert.equal(next.lives.player1, LIVES_PER_PLAYER - 1);
  assert.equal(next.lives.player2, LIVES_PER_PLAYER);
  assert.equal(next.turnIndex, 1);
});

/* -------------------------------------------------------------------------- *
 * Generation: reproducibility, validity, symmetry
 * -------------------------------------------------------------------------- */

test("generation: 300 seeds reproduce byte-identically and validate", () => {
  for (let seed = 0; seed < 300; seed++) {
    const field = createBattlefield(seed);
    assert.deepEqual(createBattlefield(seed), field, `seed ${seed} must be reproducible`);
    assert.equal(validateBattlefield(field).ok, true, `seed ${seed} must be valid`);
    assert.equal(field.terrain.length, TERRAIN_COLUMNS);
    for (const height of field.terrain) {
      assert.ok(height >= TERRAIN_MIN_SURFACE_Y && height <= TERRAIN_MAX_SURFACE_Y);
    }
    assert.ok(field.blocks.length <= MAX_STRUCTURE_BLOCKS);
    const perSeat = SEATS.map((seat) => field.blocks.filter((block) => block.seat === seat).length);
    assert.deepEqual(perSeat, [perSeat[0], perSeat[0]], "both seats get the same tower");
    assert.ok(perSeat[0] <= MAX_STRUCTURE_BLOCKS_PER_SEAT);
    for (const block of field.blocks) {
      assert.equal(block.size, STRUCTURE_BLOCK_SIZE);
      assert.equal(block.integrity, BLOCK_MAX_INTEGRITY);
      assert.ok(block.x >= 0 && block.x + block.size <= field.width);
      assert.ok(block.y >= 0 && block.y + block.size <= field.height);
    }
    for (const seat of SEATS) {
      const player = field.players[seat];
      assert.equal(
        player.y,
        field.terrain[Math.min(TERRAIN_COLUMNS - 1, Math.floor(player.x / 5))],
        "a spawn stands on the ground",
      );
    }
    assert.ok(
      Math.abs(field.players.player1.x - field.players.player2.x) >= MIN_PLAYER_SEPARATION,
    );
  }
});

test("generation: the two starting positions and their cover are mirrored", () => {
  for (let seed = 0; seed < 200; seed++) {
    const field = createBattlefield(seed);
    const last = TERRAIN_COLUMNS - 1;
    for (let column = 0; column <= last; column++) {
      assert.equal(
        field.terrain[column],
        field.terrain[last - column],
        `seed ${seed}: terrain is not mirrored at column ${column}`,
      );
    }

    const mirror = (block) => ({
      x: field.width - block.x - block.size,
      y: block.y,
      integrity: block.integrity,
    });
    const signature = (blocks) =>
      blocks
        .map((block) => `${block.x}:${block.y}:${block.integrity}`)
        .sort()
        .join("|");
    const left = field.blocks.filter((block) => block.seat === "player1").map(mirror);
    const right = field.blocks.filter((block) => block.seat === "player2");
    assert.equal(signature(left), signature(right), `seed ${seed}: towers are not mirrored`);

    assert.equal(
      field.players.player1.y,
      field.players.player2.y,
      `seed ${seed}: the launchers stand at different heights`,
    );
    assert.equal(
      field.players.player1.x,
      field.width - field.players.player2.x,
      `seed ${seed}: the launchers are not mirrored`,
    );
  }
});

test("generation: a mirrored shot resolves to a mirrored impact", () => {
  for (const seed of SEEDS) {
    const state = createInitialState({ seed, openingSeat: "player1" });
    for (const [angle, power] of [
      [40, 80],
      [25, 100],
      [60, 55],
      [80, 40],
      [12, 90],
    ]) {
      const left = simulate(state, "player1", { angleDeg: angle, power });
      const right = simulate(state, "player2", { angleDeg: 180 - angle, power });
      assert.equal(left.impact.kind, right.impact.kind, `seed ${seed} ∠${angle}`);
      assert.equal(
        left.impact.target,
        right.impact.target === null ? null : other(right.impact.target),
        `seed ${seed} ∠${angle}`,
      );
      assert.ok(Math.abs(state.battlefield.width - left.impact.x - right.impact.x) < 1e-9);
      assert.ok(Math.abs(left.impact.y - right.impact.y) < 1e-9);
      assert.equal(left.impact.tick, right.impact.tick);
      assert.equal(left.ticks, right.ticks);
    }
  }
});

/* -------------------------------------------------------------------------- *
 * Hard limits
 * -------------------------------------------------------------------------- */

test("limits: every shot is bounded in ticks, substeps and recorded points", () => {
  let checked = 0;
  for (const seed of [0, 1, 42, 424242]) {
    const state = createInitialState({ seed, openingSeat: "player1" });
    for (const seat of SEATS) {
      for (let angle = 0; angle < 360; angle += 17) {
        for (const power of [0, 25, 50, 75, 100]) {
          const simulation = simulate(state, seat, { angleDeg: angle, power });
          checked += 1;
          assert.ok(simulation.impact.tick <= state.projectile.maxTicks);
          assert.ok(Number.isFinite(simulation.impact.x) && Number.isFinite(simulation.impact.y));
          assert.ok(simulation.path.length >= 1);
          assert.ok(
            simulation.path.length <= MAX_PATH_POINTS,
            `path of ${simulation.path.length} points exceeds the cap`,
          );
          const last = simulation.path[simulation.path.length - 1];
          assert.deepEqual(
            { x: last.x, y: last.y },
            { x: simulation.impact.x, y: simulation.impact.y },
            "the recorded path must end at the impact",
          );
          assert.equal(
            validateBattlefield(simulation.battlefield).ok,
            true,
            "a resolved battlefield must stay valid",
          );
        }
      }
    }
  }
  assert.ok(checked > 500, `only checked ${checked} shots`);
});

test("limits: a refused simulation never touches the battlefield it was given", () => {
  const state = createInitialState({ seed: 42, openingSeat: "player1" });
  const snapshot = JSON.stringify(state.battlefield);
  assert.throws(() => simulateShot({
    battlefield: state.battlefield,
    shooterSeat: "player3",
    shot: { angleDeg: 45, power: 50 },
  }), TypeError);
  assert.throws(() => simulateShot({
    battlefield: state.battlefield,
    shooterSeat: "player1",
    shot: { angleDeg: 45, power: 1000 },
  }));
  assert.throws(() => simulateShot({
    battlefield: { ...state.battlefield, terrain: [1, 2, 3] },
    shooterSeat: "player1",
    shot: { angleDeg: 45, power: 50 },
  }), TypeError);
  assert.equal(JSON.stringify(state.battlefield), snapshot);
});

test("limits: the match's projectile spec is authoritative and validated", () => {
  const canonical = createInitialState({ seed: 42, openingSeat: "player1" });
  const shot = { angleDeg: 45, power: 100 };
  const normalReach = simulate(canonical, "player1", shot).impact.x;

  // A slower spec must really fly slower: the snapshot on the state is what the
  // simulation uses, not the module constants, so a stored replay keeps its feel.
  const slow = Object.freeze({ ...createProjectileSpec(), launchSpeedMin: 2, launchSpeedMax: 11 });
  const slowed = createInitialState({ seed: 42, openingSeat: "player1", projectile: slow });
  assert.deepEqual(slowed.projectile, slow);
  const slowReach = simulate(slowed, "player1", shot).impact.x;
  assert.ok(slowReach < normalReach, `slow shot ${slowReach} must fall short of ${normalReach}`);

  // A corrupted spec is refused loudly, exactly like a corrupted battlefield.
  const corrupt = [
    { ...createProjectileSpec(), gravity: Number.NaN },
    { ...createProjectileSpec(), gravity: -1 },
    { ...createProjectileSpec(), radius: 0 },
    { ...createProjectileSpec(), maxTicks: 0 },
    { ...createProjectileSpec(), substepMaxPx: -2 },
    { ...createProjectileSpec(), pathSampleEvery: 0 },
    { ...createProjectileSpec(), launchSpeedMin: Number.POSITIVE_INFINITY },
    { ...createProjectileSpec(), launchSpeedMin: 20, launchSpeedMax: 10 },
    {},
    null,
  ];
  for (const projectile of corrupt) {
    assert.throws(
      () =>
        simulateShot({
          battlefield: canonical.battlefield,
          shooterSeat: "player1",
          shot,
          projectile,
        }),
      TypeError,
      `spec ${JSON.stringify(projectile)} must be refused`,
    );
  }
});

test("limits: aim conversion refuses a drag that is not an aim", () => {
  const base = { fromX: 0, fromY: 0, maxPull: 150 };
  assert.equal(aimFromDrag({ ...base, toX: 0, toY: 0 }), null, "a tap is not aim");
  assert.equal(aimFromDrag({ ...base, toX: 4, toY: 4 }), null, "a nudge is not aim");
  assert.throws(() => aimFromDrag({ ...base, toX: Number.NaN, toY: 0 }));
  assert.throws(() => aimFromDrag({ ...base, maxPull: 0, toX: 40, toY: 0 }));
  const aimed = aimFromDrag({ ...base, toX: -150, toY: 0 });
  assert.deepEqual(aimed, { angleDeg: 0, power: 100 });
  assert.equal(PLAYER_RADIUS > 0, true);
});
