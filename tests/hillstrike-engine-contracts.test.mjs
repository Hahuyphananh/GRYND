/**
 * hillstrike-engine-contracts.test.mjs — the engine gate.
 *
 * The rule suite pins each rule in isolation. This suite pins them TOGETHER, the
 * way a real match runs them: full scripted turns (both opening seats), hits
 * that keep a turn alive, hits that end the match mid-turn, drives and builds
 * sharing the same action budget, out-of-bounds shots, malformed and
 * stale/duplicate actions at the boundary, and the hard limits (ticks, substeps,
 * path points, collapse). Every shot here is produced by searching the engine's
 * own simulation for the line that does what the case needs, so the cases cannot
 * silently stop testing what they claim.
 *
 * Run:  node --import tsx --test tests/hillstrike-engine-contracts.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_TYPES,
  ACTIONS_PER_TURN,
  BATTLEFIELD_WIDTH,
  BLOCK_MAX_INTEGRITY,
  HIT_DAMAGE_MAX,
  IMPACT_KINDS,
  MATCH_STATUS,
  MAX_HP,
  MAX_PATH_POINTS,
  MAX_STRUCTURE_BLOCKS,
  MAX_STRUCTURE_BLOCKS_PER_SEAT,
  MIN_PLAYER_SEPARATION,
  MOVE_STEP,
  OPENING_ACTIONS,
  PLAYER_RADIUS,
  REJECTION,
  STRUCTURE_BLOCK_SIZE,
  TERRAIN_COLUMNS,
  TERRAIN_MAX_SURFACE_Y,
  TERRAIN_MIN_SURFACE_Y,
} from "../src/lib/hillstrike/constants.ts";
import { createBattlefield, validateBattlefield } from "../src/lib/hillstrike/generation.ts";
import { aimFromDrag, createProjectileSpec, simulateShot } from "../src/lib/hillstrike/physics.ts";
import {
  applyAction,
  buildPlacementFor,
  createInitialState,
  hpOf,
  isHillstrikeRuleError,
  tryApplyAction,
} from "../src/lib/hillstrike/rules.ts";

const SEATS = ["player1", "player2"];
const SEEDS = [0, 1, 7, 42, 424242, 987654];

const other = (seat) => (seat === "player1" ? "player2" : "player1");
const shoot = (shot) => ({ type: ACTION_TYPES.SHOOT, ...shot });

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

/**
 * A direct hit on the other tank.
 *
 * The cover walls are tall, so the opening hit window is narrow: a coarse grid
 * would only ever report stone. This is a fine sweep (0.5° of angle over the
 * forward arc) at the high power bands, which is what a player aiming with the
 * preview does too.
 */
function hitShot(state, seat) {
  const arc = seat === "player1" ? [0, 180] : [0, 180];
  for (let power = 100; power >= 55; power -= 5) {
    for (let angle = arc[0]; angle < arc[1]; angle += 0.5) {
      const shot = { angleDeg: angle, power };
      const simulation = simulate(state, seat, shot);
      if (simulation.impact.kind === IMPACT_KINDS.PLAYER && simulation.impact.target === other(seat)) {
        return shot;
      }
    }
  }
  throw new Error(`no direct hit found for ${seat} (seed ${state.seed}, ply ${state.turnIndex})`);
}

const blockShot = (state, seat) => findShot(state, seat, IMPACT_KINDS.BLOCK);

/**
 * A shot that sails clean over everything and out of the battlefield.
 *
 * On this battlefield the field is open at the top of the arc, so a full-power
 * lob overshoots the far wall — which is exactly the "how did I miss that badly"
 * miss a player produces with the wrong power.
 */
function outOfBoundsShot(state, seat) {
  // The doubled map is wide, so the escape line differs per seed and per
  // battlefield: scan the whole circle, hardest shots first, and take the first
  // line that leaves the field without meeting anything.
  for (const power of [100, 95, 90]) {
    for (let angle = 0; angle < 360; angle += 1) {
      const shot = { angleDeg: angle, power };
      if (simulate(state, seat, shot).impact.kind === IMPACT_KINDS.OUT_OF_BOUNDS) return shot;
    }
  }
  throw new Error(`no out-of-bounds line for ${seat} on seed ${state.seed}`);
}

/* -------------------------------------------------------------------------- *
 * Turns
 * -------------------------------------------------------------------------- */

test("turns: the opening seat takes one action, then every turn is exactly two", () => {
  for (const openingSeat of SEATS) {
    let state = createInitialState({ seed: 424242, openingSeat });
    const timeline = [
      { turn: state.turn, actions: state.actionsRemaining, index: state.turnIndex },
    ];
    let guard = 0;

    while (state.status === MATCH_STATUS.PLAYING && guard < 40) {
      const shooter = state.turn;
      // Alternate between hitting and breaking cover: the counter must not care
      // whether an action connects.
      let shot;
      try {
        shot = guard % 3 === 0 ? hitShot(state, shooter) : blockShot(state, shooter);
      } catch {
        shot = outOfBoundsShot(state, shooter);
      }
      state = applyAction(state, shooter, shoot(shot)).state;
      guard += 1;
      if (state.status === MATCH_STATUS.PLAYING) {
        timeline.push({
          turn: state.turn,
          actions: state.actionsRemaining,
          index: state.turnIndex,
        });
      }
    }

    assert.equal(state.status, MATCH_STATUS.FINISHED, "the scripted match must terminate");
    assert.ok(guard >= 3, "a match cannot end before three actions");

    // Action 0 is the opening single-action turn: the turn passes immediately.
    assert.equal(timeline[0].index, 0);
    assert.equal(timeline[0].actions, OPENING_ACTIONS);
    assert.equal(timeline[1].turn, other(openingSeat), "the answering seat gets the next turn");
    assert.equal(timeline[1].actions, ACTIONS_PER_TURN);

    // Everything after the opening is a pair: the same seat twice, then swap.
    for (let index = 1; index + 1 < timeline.length; index += 2) {
      assert.equal(timeline[index].turn, timeline[index + 1].turn, "a turn is two actions");
      assert.equal(timeline[index].actions, 2);
      assert.equal(timeline[index + 1].actions, 1);
      if (timeline[index + 2]) {
        assert.equal(
          timeline[index + 2].turn,
          other(timeline[index].turn),
          "the turn passes to the other seat",
        );
      }
    }
  }
});

test("turns: two hits in one turn both land, and the turn still passes", () => {
  let state = createInitialState({ seed: 42, openingSeat: "player1" });
  const shooter = "player2";

  state = applyAction(state, "player1", shoot(outOfBoundsShot(state, "player1"))).state;
  assert.equal(state.turn, shooter);

  const first = shoot(hitShot(state, shooter));
  const afterFirst = applyAction(state, shooter, first).state;

  assert.ok(hpOf(afterFirst, "player1") < MAX_HP);
  assert.equal(
    hpOf(afterFirst, "player1"),
    MAX_HP - afterFirst.lastAction.damage,
    "the HP taken is the damage the engine resolved",
  );
  assert.equal(afterFirst.turn, shooter, "a hit does not end the turn");
  assert.equal(afterFirst.actionsRemaining, 1);
  assert.equal(afterFirst.status, MATCH_STATUS.PLAYING);

  const hpAfterFirst = hpOf(afterFirst, "player1");
  const second = shoot(hitShot(afterFirst, shooter));
  const afterSecond = applyAction(afterFirst, shooter, second).state;

  assert.ok(hpOf(afterSecond, "player1") < hpAfterFirst, "the second hit also lands");
  assert.equal(afterSecond.turn, "player1", "the turn passes after its second action");
  assert.equal(afterSecond.actionsRemaining, ACTIONS_PER_TURN);
  assert.equal(afterSecond.turnIndex, 3);
});

test("turns: a knockout on the FIRST action ends the match and voids the second", () => {
  let state = createInitialState({ seed: 7, openingSeat: "player2" });

  /** Burn misses until `seat` owns a FRESH two-action turn. */
  const passToFreshTurn = (seat) => {
    let guard = 0;
    while (
      state.status === MATCH_STATUS.PLAYING &&
      (state.turn !== seat || state.actionsRemaining !== ACTIONS_PER_TURN) &&
      guard < 12
    ) {
      const shooter = state.turn;
      state = applyAction(state, shooter, shoot(outOfBoundsShot(state, shooter))).state;
      guard += 1;
    }
    assert.ok(guard < 12, `could not reach a fresh turn for ${seat}`);
  };

  passToFreshTurn("player2");
  assert.equal(state.turn, "player2");
  assert.equal(state.actionsRemaining, ACTIONS_PER_TURN);

  // One hit from elimination: the engine reads its own HP field, so staging the
  // victim on 1 HP is exactly the position a real duel arrives at.
  state = { ...state, hp: { ...state.hp, player1: 1 } };
  const lethal = applyAction(state, "player2", shoot(hitShot(state, "player2")));
  const ended = lethal.state;

  assert.equal(ended.status, MATCH_STATUS.FINISHED);
  assert.equal(ended.winner, "player2");
  assert.equal(ended.terminationReason, "hp-depleted");
  assert.equal(ended.hp.player1, 0);
  assert.equal(ended.actionsRemaining, 0, "the turn dies with the match");
  assert.ok(
    lethal.events.some((event) => event.type === "match-ended" && event.winner === "player2"),
    "the animation stream carries the terminal event",
  );

  const denied = tryApplyAction(ended, "player2", shoot(hitShot(state, "player2")));
  assert.equal(denied.ok, false);
  assert.equal(denied.code, REJECTION.MATCH_NOT_PLAYING);
});

test("turns: HP never goes below zero, and a hit never exceeds the damage cap", () => {
  let state = createInitialState({ seed: 987654, openingSeat: "player2" });
  let actions = 0;
  while (state.status === MATCH_STATUS.PLAYING && actions < 40) {
    const shooter = state.turn;
    const before = { ...state.hp };
    const shot = shoot(hitShot(state, shooter));
    const next = applyAction(state, shooter, shot).state;
    const victim = other(shooter);

    assert.equal(next.hp[victim], Math.max(0, before[victim] - next.lastAction.damage));
    assert.ok(next.lastAction.damage >= 1 && next.lastAction.damage <= HIT_DAMAGE_MAX);
    assert.equal(next.hp[shooter], before[shooter], "the shooter never loses HP");
    assert.ok(next.hp[victim] >= 0);
    state = next;
    actions += 1;
  }
  assert.equal(state.status, MATCH_STATUS.FINISHED);
  assert.equal(state.hp[other(state.winner)], 0);
  assert.ok(state.hp[state.winner] > 0);
});

/* -------------------------------------------------------------------------- *
 * Drives and builds share the same budget as a shot
 * -------------------------------------------------------------------------- */

test("actions: a drive spends one action and changes nothing but the tank", () => {
  let state = createInitialState({ seed: 424242, openingSeat: "player1" });
  const before = state.battlefield.players.player1;
  const startHp = { ...state.hp };
  const startBlocks = state.battlefield.blocks.length;

  state = applyAction(state, "player1", {
    type: ACTION_TYPES.MOVE,
    direction: "forward",
  }).state;

  assert.equal(state.battlefield.players.player1.x, before.x + MOVE_STEP);
  assert.equal(state.battlefield.blocks.length, startBlocks, "a drive builds nothing");
  assert.deepEqual(state.hp, startHp, "a drive costs no HP");
  assert.equal(state.turn, "player2", "the opening action was the only one");
  assert.equal(state.actionsRemaining, ACTIONS_PER_TURN);
  assert.equal(state.lastAction.type, "move");
});

test("actions: drive-then-fire is a legal two-action turn", () => {
  let state = createInitialState({ seed: 424242, openingSeat: "player1" });
  state = applyAction(state, "player1", shoot(outOfBoundsShot(state, "player1"))).state;
  assert.equal(state.turn, "player2");

  const driven = applyAction(state, "player2", {
    type: ACTION_TYPES.MOVE,
    direction: "forward",
  }).state;
  assert.equal(driven.turn, "player2", "the turn continues after a drive");
  assert.equal(driven.actionsRemaining, 1);

  const fired = applyAction(driven, "player2", shoot(outOfBoundsShot(driven, "player2")));
  assert.equal(fired.state.turn, "player1");
  assert.equal(fired.state.turnIndex, state.turnIndex + 2);
});

test("actions: build-then-fire is a legal two-action turn, and the block is real cover", () => {
  let state = createInitialState({ seed: 424242, openingSeat: "player1" });
  state = applyAction(state, "player1", shoot(outOfBoundsShot(state, "player1"))).state;

  // A build names the tile it wants; the engine derives the block itself.
  const placement = buildPlacementFor(state, "player2");
  assert.ok(placement, "player2 has somewhere legal to build");
  const built = applyAction(state, "player2", {
    type: ACTION_TYPES.BUILD,
    x: placement.x,
    y: placement.y,
  }).state;
  const added = built.battlefield.blocks.length - state.battlefield.blocks.length;
  assert.equal(added, 1, "a build places exactly one block");
  assert.equal(built.turn, "player2");
  assert.equal(built.actionsRemaining, 1);
  assert.equal(built.lastAction.type, "build");

  const block = built.battlefield.blocks.find(
    (candidate) => candidate.id === built.lastAction.blockId,
  );
  assert.ok(block, "the record names the block");
  assert.equal(block.seat, "player2");
  assert.equal(block.kind, "cover");
  assert.equal(block.integrity, BLOCK_MAX_INTEGRITY);
  assert.equal(block.size, STRUCTURE_BLOCK_SIZE);
  assert.ok(block.x + block.size < built.battlefield.players.player2.x, "cover faces the enemy");

  const fired = applyAction(built, "player2", shoot(outOfBoundsShot(built, "player2")));
  assert.equal(fired.state.turn, "player1");
});

test("actions: a finished match refuses all three action types", () => {
  const finished = Object.freeze({
    ...createInitialState({ seed: 3, openingSeat: "player1" }),
    status: MATCH_STATUS.FINISHED,
    hp: { player1: 40, player2: 0 },
    winner: "player1",
    terminationReason: "hp-depleted",
    actionsRemaining: 0,
  });

  for (const action of [
    shoot({ angleDeg: 45, power: 80 }),
    { type: ACTION_TYPES.MOVE, direction: "forward" },
    { type: ACTION_TYPES.BUILD },
  ]) {
    const refused = tryApplyAction(finished, "player1", action);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, REJECTION.MATCH_NOT_PLAYING);
  }
});

/* -------------------------------------------------------------------------- *
 * Shots that change nothing
 * -------------------------------------------------------------------------- */

test("out-of-bounds: the action is consumed, costs nothing and changes no ground", () => {
  let state = createInitialState({ seed: 424242, openingSeat: "player1" });
  state = applyAction(state, "player1", shoot(outOfBoundsShot(state, "player1"))).state;
  const shooter = state.turn;

  const beforeTerrain = [...state.battlefield.terrain];
  const beforeBlocks = state.battlefield.blocks.map((block) => ({ ...block }));
  const beforeHp = { ...state.hp };

  const result = applyAction(state, shooter, shoot(outOfBoundsShot(state, shooter)));
  const after = result.state;

  assert.equal(after.lastAction.impact.kind, IMPACT_KINDS.OUT_OF_BOUNDS);
  assert.equal(after.lastAction.damage, 0);
  assert.deepEqual(after.hp, beforeHp);
  assert.deepEqual(after.battlefield.terrain, beforeTerrain, "no crater from a miss");
  assert.deepEqual(
    after.battlefield.blocks.map((block) => ({ ...block })),
    beforeBlocks,
    "no structural damage from a miss",
  );
  assert.equal(after.turnIndex, state.turnIndex + 1, "it still used an action");
  assert.equal(
    result.events.some((event) => event.type === "player-hit"),
    false,
    "no hit event",
  );
  assert.equal(validateBattlefield(after.battlefield).ok, true);
});

test("timeout: a shot that never lands is bounded and harmless", () => {
  const state = createInitialState({ seed: 11, openingSeat: "player1" });
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
    [null, REJECTION.INVALID_ACTION],
    [undefined, REJECTION.INVALID_ACTION],
    ["45,80", REJECTION.INVALID_ACTION],
    [[45, 80], REJECTION.INVALID_ACTION],
    [{}, REJECTION.INVALID_ACTION],
    [{ type: "jump" }, REJECTION.INVALID_ACTION],
    [{ angleDeg: 45, power: 80 }, REJECTION.INVALID_ACTION],
    [{ type: "shoot" }, REJECTION.INVALID_SHOT],
    [{ type: "shoot", angleDeg: 45 }, REJECTION.INVALID_SHOT],
    [{ type: "shoot", power: 80 }, REJECTION.INVALID_SHOT],
    [{ type: "shoot", angleDeg: Number.NaN, power: 80 }, REJECTION.ANGLE_INVALID],
    [{ type: "shoot", angleDeg: Number.POSITIVE_INFINITY, power: 80 }, REJECTION.ANGLE_INVALID],
    [{ type: "shoot", angleDeg: -0.001, power: 80 }, REJECTION.ANGLE_INVALID],
    [{ type: "shoot", angleDeg: 360, power: 80 }, REJECTION.ANGLE_INVALID],
    [{ type: "shoot", angleDeg: 1e9, power: 80 }, REJECTION.ANGLE_INVALID],
    [{ type: "shoot", angleDeg: "45", power: 80 }, REJECTION.ANGLE_INVALID],
    [{ type: "shoot", angleDeg: 45, power: Number.NaN }, REJECTION.POWER_INVALID],
    [{ type: "shoot", angleDeg: 45, power: 100.5 }, REJECTION.POWER_INVALID],
    [{ type: "shoot", angleDeg: 45, power: -1 }, REJECTION.POWER_INVALID],
    [{ type: "shoot", angleDeg: 45, power: 101 }, REJECTION.POWER_INVALID],
    [{ type: "shoot", angleDeg: 45, power: "80" }, REJECTION.POWER_INVALID],
    [{ type: "move" }, REJECTION.INVALID_DIRECTION],
    [{ type: "move", direction: "up" }, REJECTION.INVALID_DIRECTION],
  ];
  for (const [action, code] of cases) {
    const verdict = tryApplyAction(state, seat, action);
    assert.equal(verdict.ok, false, `payload ${JSON.stringify(action)} must be refused`);
    assert.equal(verdict.code, code, `payload ${JSON.stringify(action)}`);
    assert.throws(() => applyAction(state, seat, action), (error) => {
      assert.ok(isHillstrikeRuleError(error));
      assert.equal(error.code, code);
      return true;
    });
  }
  assert.equal(JSON.stringify(state), before, "a refused action never mutates the state");

  // Extra fields are ignored, not honoured: the shot resolves exactly as without.
  const clean = { type: "shoot", angleDeg: 30, power: 70 };
  const padded = { ...clean, damage: 99, target: "player2", x: 0, y: 0, hp: 0 };
  assert.deepEqual(
    applyAction(state, seat, padded).state.lastAction.impact,
    applyAction(state, seat, clean).state.lastAction.impact,
  );
  assert.equal(applyAction(state, seat, padded).state.hp.player2, MAX_HP);
});

test("boundary: a build cannot be used to smuggle a block, only to name a tile", () => {
  const state = createInitialState({ seed: 42, openingSeat: "player1" });
  const placement = buildPlacementFor(state, "player1");
  assert.ok(placement);

  const clean = { type: "build", x: placement.x, y: placement.y };
  // Everything else a client might attach is ignored: the block's id, size,
  // integrity, kind and owner are all derived by the engine.
  const padded = {
    ...clean,
    blockId: 999,
    seat: "player2",
    size: 999,
    integrity: 5,
    kind: "roof",
  };
  const plain = applyAction(state, "player1", clean).state;
  const smuggled = applyAction(state, "player1", padded).state;

  assert.deepEqual(smuggled.battlefield.blocks, plain.battlefield.blocks);
  assert.deepEqual(smuggled.lastAction, plain.lastAction);
  assert.notEqual(plain.lastAction.blockId, 999);
  const block = plain.battlefield.blocks.find((entry) => entry.id === plain.lastAction.blockId);
  assert.equal(block.seat, "player1", "the owner is the actor, never the payload");
  assert.equal(block.kind, "cover");
  assert.equal(block.size, STRUCTURE_BLOCK_SIZE);
  assert.equal(block.integrity, BLOCK_MAX_INTEGRITY);

  // The tile IS validated: the opponent's half is refused outright.
  const acrossTheLine = tryApplyAction(state, "player1", {
    type: "build",
    x: BATTLEFIELD_WIDTH / 2,
    y: placement.y,
  });
  assert.equal(acrossTheLine.ok, false);
  assert.equal(acrossTheLine.code, REJECTION.BUILD_OPPONENT_HALF);
});

test("boundary: duplicate and stale actions cannot double-apply or replay a cached outcome", () => {
  const state = createInitialState({ seed: 1, openingSeat: "player1" });
  const shot = shoot(hitShot(state, "player1"));

  // 1. The same call twice is pure: identical results, and neither mutates input.
  const first = applyAction(state, "player1", shot);
  const repeat = applyAction(state, "player1", shot);
  assert.deepEqual(repeat.state, first.state);
  assert.deepEqual(repeat.events, first.events);
  assert.equal(state.hp.player1, MAX_HP, "the input state is untouched");

  // 2. Replaying the SAME payload against the ADVANCED state is refused when the
  //    turn moved (the opening turn is one action), so a duplicated request can
  //    never take a second helping of HP.
  const duplicated = tryApplyAction(first.state, "player1", shot);
  assert.equal(duplicated.ok, false);
  assert.equal(duplicated.code, REJECTION.NOT_YOUR_TURN);
  assert.ok(first.state.hp.player2 < MAX_HP);

  // 3. Inside a two-action turn the same payload IS legal twice (two separate
  //    actions), and each one applies exactly once.
  let state2 = createInitialState({ seed: 2, openingSeat: "player2" });
  state2 = applyAction(state2, "player2", shoot(outOfBoundsShot(state2, "player2"))).state;
  assert.equal(state2.turn, "player1");
  assert.equal(state2.actionsRemaining, ACTIONS_PER_TURN);

  const volleyShot = shoot(hitShot(state2, "player1"));
  const a = applyAction(state2, "player1", volleyShot).state;
  const b = applyAction(a, "player1", volleyShot).state;
  assert.ok(a.hp.player2 < MAX_HP);
  assert.ok(b.hp.player2 < a.hp.player2, "the second action lands separately");

  // 4. A STALE action (resolved against an older battlefield) is re-validated and
  //    re-simulated against the CURRENT one: no cached outcome is replayed.
  let staleState = createInitialState({ seed: 2, openingSeat: "player2" });
  staleState = applyAction(staleState, "player2", shoot(outOfBoundsShot(staleState, "player2"))).state;
  assert.equal(staleState.turn, "player1");

  // Distance no longer weakens a crater, so a ground shot always changes the
  // battlefield the next resolution sees.
  const groundShot = shoot({ angleDeg: 12, power: 100 });
  const staleOutcome = simulate(staleState, "player1", groundShot).impact;
  assert.equal(staleOutcome.kind, IMPACT_KINDS.TERRAIN);

  const terrainBefore = staleState.battlefield.terrain;
  let cleared = applyAction(staleState, "player1", groundShot).state;
  cleared = applyAction(cleared, "player1", groundShot).state; // the turn's second action
  assert.notDeepEqual(cleared.battlefield.terrain, terrainBefore, "the ground really changed");

  let guard = 0;
  while (cleared.status === MATCH_STATUS.PLAYING && cleared.turn !== "player1" && guard < 6) {
    const shooter = cleared.turn;
    cleared = applyAction(cleared, shooter, shoot(outOfBoundsShot(cleared, shooter))).state;
    guard += 1;
  }
  assert.equal(cleared.turn, "player1");

  const revalidated = simulate(cleared, "player1", groundShot).impact;
  const appliedNow = applyAction(cleared, "player1", groundShot).state.lastAction.impact;
  assert.deepEqual(appliedNow, revalidated, "the shot resolves against the live battlefield");
  assert.notDeepEqual(
    { x: appliedNow.x, y: appliedNow.y, kind: appliedNow.kind },
    { x: staleOutcome.x, y: staleOutcome.y, kind: staleOutcome.kind },
    "the old resolution is not replayed",
  );
});

test("boundary: the shooter may hit themselves, and it costs them HP", () => {
  const state = createInitialState({ seed: 3, openingSeat: "player1" });
  const selfShot = (() => {
    for (let angle = 150; angle <= 210; angle += 0.5) {
      for (let power = 40; power <= 100; power += 2) {
        const shot = { angleDeg: angle, power };
        const impact = simulate(state, "player1", shot).impact;
        if (impact.kind === IMPACT_KINDS.PLAYER && impact.target === "player1") return shot;
      }
    }
    return null;
  })();
  if (!selfShot) return; // no self-hit line on this layout: nothing to assert.

  const next = applyAction(state, "player1", shoot(selfShot)).state;
  assert.ok(next.hp.player1 < MAX_HP);
  assert.equal(next.hp.player2, MAX_HP);
  assert.equal(next.turnIndex, 1);
  assert.equal(next.lastAction.damage, MAX_HP - next.hp.player1);
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
      `seed ${seed}: the tanks stand at different heights`,
    );
    assert.equal(
      field.players.player1.x,
      field.width - field.players.player2.x,
      `seed ${seed}: the tanks are not mirrored`,
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
  assert.throws(
    () =>
      simulateShot({
        battlefield: state.battlefield,
        shooterSeat: "player3",
        shot: { angleDeg: 45, power: 50 },
      }),
    TypeError,
  );
  assert.throws(() =>
    simulateShot({
      battlefield: state.battlefield,
      shooterSeat: "player1",
      shot: { angleDeg: 45, power: 1000 },
    }),
  );
  assert.throws(
    () =>
      simulateShot({
        battlefield: { ...state.battlefield, terrain: [1, 2, 3] },
        shooterSeat: "player1",
        shot: { angleDeg: 45, power: 50 },
      }),
    TypeError,
  );
  assert.equal(JSON.stringify(state.battlefield), snapshot);
});

test("limits: the match's projectile spec is authoritative and validated", () => {
  const canonical = createInitialState({ seed: 42, openingSeat: "player1" });
  const shot = { angleDeg: 45, power: 100 };
  const normalReach = simulate(canonical, "player1", shot).impact.x;

  const slow = Object.freeze({ ...createProjectileSpec(), launchSpeedMin: 2, launchSpeedMax: 11 });
  const slowed = createInitialState({ seed: 42, openingSeat: "player1", projectile: slow });
  assert.deepEqual(slowed.projectile, slow);
  const slowReach = simulate(slowed, "player1", shot).impact.x;
  assert.ok(slowReach < normalReach, `slow shot ${slowReach} must fall short of ${normalReach}`);

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
