/**
 * hillstrike-ai.test.mjs — the bot contract.
 *
 * The practice bot is the ONLY opponent in Hillstrike, so its honesty is a
 * gameplay property, not a detail: difficulty may change how carefully it
 * PICKS an action and nothing else. This suite pins that:
 *
 *   • it returns ONE of the engine's three actions — a shot, a drive or a build
 *     — carrying no damage modifier, no projectile and no hidden bonus that
 *     could make a "hard" bot hit harder than an "easy" one;
 *   • every candidate it considers is resolved by the SAME `simulateShot` and
 *     the SAME projectile spec the match uses, and every action it returns is
 *     one `validateAction` accepts;
 *   • a stronger tier aims better (more direct hits among the shots it takes),
 *     never shoots further;
 *   • it is deterministic under an injected random, bounded in cost, refuses to
 *     plan out of turn, and never mutates the authoritative state.
 *
 * Run:  node --import tsx --test tests/hillstrike-ai.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  AI_PUBLIC_STATE_KEYS,
  AI_SEARCH_PLANS,
  aiAimGrid,
  aiCandidateBudget,
  chooseAiAction,
  compareAiScores,
  HILLSTRIKE_TIER_HINTS,
  scoreAiShot,
} from "../src/lib/hillstrike/ai.ts";
import {
  ACTION_TYPES,
  HIT_DAMAGE_MAX,
  IMPACT_KINDS,
  MATCH_STATUS,
  MAX_HP,
  POWER_MAX,
} from "../src/lib/hillstrike/constants.ts";
import { createProjectileSpec, simulateShot } from "../src/lib/hillstrike/physics.ts";
import { applyAction, createInitialState, hpOf, validateAction } from "../src/lib/hillstrike/rules.ts";
import { AI_DIFFICULTIES, coerceAiDifficulty } from "../src/lib/aiDifficulty.ts";

const SEATS = ["player1", "player2"];
const AI_SEAT = "player2";
const HUMAN_SEAT = "player1";

/** A state where the bot owns the turn (the only state a caller may ask in). */
function stateWithBotToPlay(seed, { openingSeat = HUMAN_SEAT } = {}) {
  const fresh = createInitialState({ seed, openingSeat });
  // Hand the turn to the bot through the engine, never by editing the state.
  if (openingSeat === HUMAN_SEAT) {
    const lob = { type: ACTION_TYPES.SHOOT, angleDeg: 45, power: 100 };
    const next = applyAction(fresh, HUMAN_SEAT, lob).state;
    assert.equal(next.turn, AI_SEAT, "the bot must own the turn for these cases");
    return next;
  }
  return fresh;
}

/** Resolve a shot exactly as the match would, and report what it hit. */
function resolve(state, seat, shot) {
  return simulateShot({
    battlefield: state.battlefield,
    shooterSeat: seat,
    shot,
    projectile: state.projectile,
  }).impact;
}

/** `random` that never slips: 1 is above every tier's mistake rate. */
const neverSlips = () => 1;

test("hillstrike ai: the bot returns one action, and nothing but an action", () => {
  for (const seed of [1, 7, 42, 424242]) {
    const state = stateWithBotToPlay(seed);
    for (const difficulty of AI_DIFFICULTIES) {
      const action = chooseAiAction({ state, seat: AI_SEAT, difficulty, random: neverSlips });

      assert.ok(
        [ACTION_TYPES.SHOOT, ACTION_TYPES.MOVE, ACTION_TYPES.BUILD].includes(action.type),
        `unexpected action type ${action.type}`,
      );
      assert.equal(action.type, "shoot" in action ? "shoot" : action.type);
      if (action.type === ACTION_TYPES.SHOOT) {
        assert.deepEqual(Object.keys(action).sort(), ["angleDeg", "power", "type"]);
        assert.equal(Number.isFinite(action.angleDeg), true);
        assert.equal(Number.isInteger(action.power), true);
        assert.ok(action.power >= 0 && action.power <= POWER_MAX, `power ${action.power}`);
        // The bot fires forwards: player2 shoots to the left.
        assert.ok(action.angleDeg > 90 && action.angleDeg <= 180, `angle ${action.angleDeg}`);
      } else if (action.type === ACTION_TYPES.MOVE) {
        assert.deepEqual(Object.keys(action).sort(), ["direction", "type"]);
        assert.ok(["forward", "back"].includes(action.direction));
      } else {
        assert.deepEqual(Object.keys(action), ["type"]);
      }

      // Whatever it picked, the engine must accept it.
      assert.deepEqual(validateAction(state, AI_SEAT, action), { ok: true });
    }
  }
});

test("hillstrike ai: difficulty changes the AIM, never the projectile or the physics", () => {
  const seed = 987654;
  const state = stateWithBotToPlay(seed);

  for (const difficulty of AI_DIFFICULTIES) {
    const action = chooseAiAction({ state, seat: AI_SEAT, difficulty, random: neverSlips });
    assert.equal(action.type, ACTION_TYPES.SHOOT, "this position offers a usable line");
    const viaState = resolve(state, AI_SEAT, action);
    const viaExplicit = simulateShot({
      battlefield: state.battlefield,
      shooterSeat: AI_SEAT,
      shot: action,
      projectile: state.projectile,
    }).impact;
    assert.deepEqual(viaState, viaExplicit, "the same shot through the same physics");
    assert.ok(
      Object.values(IMPACT_KINDS).includes(viaState.kind),
      `impact kind ${viaState.kind} is a real one`,
    );
  }

  // A stronger tier never aims worse than a weaker one on the same position.
  const distanceOf = (impact) => {
    const defender = state.battlefield.players[HUMAN_SEAT];
    return Math.hypot(impact.x - defender.x, impact.y - defender.y);
  };
  const easy = resolve(state, AI_SEAT, chooseAiAction({ state, seat: AI_SEAT, difficulty: "easy", random: neverSlips }));
  const hard = resolve(state, AI_SEAT, chooseAiAction({ state, seat: AI_SEAT, difficulty: "hard", random: neverSlips }));
  assert.ok(
    hard.kind === IMPACT_KINDS.PLAYER || distanceOf(hard) <= distanceOf(easy) + 1e-6,
    `hard (${hard.kind}, ${distanceOf(hard).toFixed(1)}px) should aim at least as well as easy ` +
      `(${easy.kind}, ${distanceOf(easy).toFixed(1)}px)`,
  );
});

test("hillstrike ai: a stronger tier lands at least as many direct hits across seeds", () => {
  const seeds = [3, 11, 29, 101, 555, 4242, 9001, 31337];
  let compared = 0;
  let harder = 0;
  let easier = 0;
  for (const seed of seeds) {
    const state = stateWithBotToPlay(seed);
    const easy = chooseAiAction({ state, seat: AI_SEAT, difficulty: "easy", random: neverSlips });
    const hard = chooseAiAction({ state, seat: AI_SEAT, difficulty: "hard", random: neverSlips });
    // Only seeds where both tiers chose to fire say anything about aiming; a
    // tier that spends the action on a drive or a build has not mis-aimed.
    if (easy.type !== ACTION_TYPES.SHOOT || hard.type !== ACTION_TYPES.SHOOT) continue;
    compared += 1;
    if (resolve(state, AI_SEAT, hard).kind === IMPACT_KINDS.PLAYER) harder += 1;
    if (resolve(state, AI_SEAT, easy).kind === IMPACT_KINDS.PLAYER) easier += 1;
  }
  assert.ok(compared >= 4, `enough seeds to compare (got ${compared})`);
  assert.ok(
    harder >= easier,
    `hard (${harder}/${compared}) must not be worse than easy (${easier}/${compared})`,
  );
});

test("hillstrike ai: the bot is deterministic for a given random stream", () => {
  const state = stateWithBotToPlay(424242);

  for (const difficulty of AI_DIFFICULTIES) {
    const once = chooseAiAction({ state, seat: AI_SEAT, difficulty, random: neverSlips });
    const twice = chooseAiAction({ state, seat: AI_SEAT, difficulty, random: neverSlips });
    assert.deepEqual(twice, once, `${difficulty} repeats itself`);
  }

  const streamed = (values) => {
    let index = 0;
    return () => values[index++ % values.length];
  };
  const first = chooseAiAction({
    state,
    seat: AI_SEAT,
    difficulty: "easy",
    random: streamed([0.99, 0.5, 0.25]),
  });
  const second = chooseAiAction({
    state,
    seat: AI_SEAT,
    difficulty: "easy",
    random: streamed([0.99, 0.5, 0.25]),
  });
  assert.deepEqual(second, first);

  const slipped = chooseAiAction({ state, seat: AI_SEAT, difficulty: "easy", random: streamed([0, 0, 0]) });
  const best = chooseAiAction({ state, seat: AI_SEAT, difficulty: "easy", random: neverSlips });
  assert.notDeepEqual(slipped, best, "an easy tier slip picks a different line");
});

test("hillstrike ai: the bot refuses to plan out of turn or after the match", () => {
  const state = stateWithBotToPlay(77);

  assert.throws(
    () => chooseAiAction({ state, seat: HUMAN_SEAT, difficulty: "normal" }),
    /not this seat's turn/,
  );
  assert.throws(() => chooseAiAction({ state, seat: "player3", difficulty: "normal" }), TypeError);
  assert.throws(() => chooseAiAction({ state: null, seat: AI_SEAT, difficulty: "normal" }), TypeError);

  const finished = Object.freeze({
    ...state,
    status: MATCH_STATUS.FINISHED,
    hp: { player1: MAX_HP, player2: 0 },
    winner: HUMAN_SEAT,
    terminationReason: "hp-depleted",
  });
  assert.throws(
    () => chooseAiAction({ state: finished, seat: AI_SEAT, difficulty: "normal" }),
    /already over/,
  );
});

test("hillstrike ai: planning never mutates the authoritative state", () => {
  const state = stateWithBotToPlay(2024);
  const before = JSON.stringify(state);
  for (const difficulty of AI_DIFFICULTIES) {
    chooseAiAction({ state, seat: AI_SEAT, difficulty, random: neverSlips });
  }
  assert.equal(JSON.stringify(state), before, "the bot is a pure function of the state");
});

test("hillstrike ai: cost is bounded and an unknown tier cannot crash a match", () => {
  const state = stateWithBotToPlay(8888);

  const startedAt = process.hrtime.bigint();
  for (let repeat = 0; repeat < 5; repeat++) {
    chooseAiAction({ state, seat: AI_SEAT, difficulty: "hard", random: neverSlips });
  }
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.ok(elapsedMs < 5000, `five hard plans took ${elapsedMs.toFixed(0)}ms`);

  const unknown = chooseAiAction({
    state,
    seat: AI_SEAT,
    difficulty: "impossible",
    random: neverSlips,
  });
  const normal = chooseAiAction({ state, seat: AI_SEAT, difficulty: "normal", random: neverSlips });
  assert.deepEqual(unknown, normal);
  assert.equal(coerceAiDifficulty("impossible"), "normal");
});

test("hillstrike ai: every tier is explained in the shared vocabulary", () => {
  for (const difficulty of AI_DIFFICULTIES) {
    assert.equal(typeof HILLSTRIKE_TIER_HINTS[difficulty], "string");
    assert.ok(HILLSTRIKE_TIER_HINTS[difficulty].length > 20, `${difficulty} has a real hint`);
  }
});

test("hillstrike ai: the search is a bounded, seat-local, monotonic grid", () => {
  for (const difficulty of AI_DIFFICULTIES) {
    for (const seat of SEATS) {
      const grid = aiAimGrid(difficulty, seat);
      assert.ok(grid.length > 0);
      const keys = new Set(grid.map((shot) => `${shot.angleDeg}:${shot.power}`));
      assert.equal(keys.size, grid.length, `${difficulty}/${seat} has no duplicate line`);
      for (const shot of grid) {
        assert.ok(Number.isInteger(shot.power));
        assert.ok(shot.power >= 0 && shot.power <= POWER_MAX);
        if (seat === HUMAN_SEAT) {
          assert.ok(shot.angleDeg >= 0 && shot.angleDeg <= 90, "player1 fires into the field");
        } else {
          assert.ok(shot.angleDeg >= 90 && shot.angleDeg <= 180, "player2 fires into the field");
        }
      }
    }
  }

  const angleSteps = AI_DIFFICULTIES.map((difficulty) => AI_SEARCH_PLANS[difficulty].angleStep);
  assert.deepEqual(angleSteps, [...angleSteps].sort((a, b) => b - a), "tiers refine downwards");
  assert.ok(angleSteps[0] > angleSteps[1] && angleSteps[1] > angleSteps[2]);
  const sizes = AI_DIFFICULTIES.map((difficulty) => aiAimGrid(difficulty, HUMAN_SEAT).length);
  assert.ok(sizes[0] < sizes[1] && sizes[1] < sizes[2], `grid sizes must grow (${sizes.join(" < ")})`);

  // Grid + refinement + the top-K resolutions + one probe each for drive/build.
  const budgets = AI_DIFFICULTIES.map((difficulty) => aiCandidateBudget(difficulty));
  assert.deepEqual(budgets, [25, 76, 267], "the cost ceilings are stable");
  for (const [index, difficulty] of AI_DIFFICULTIES.entries()) {
    assert.ok(aiAimGrid(difficulty, HUMAN_SEAT).length <= budgets[index]);
    assert.ok(budgets[index] <= 300, `${difficulty} must stay inside a few hundred sims`);
  }
  assert.deepEqual(
    AI_DIFFICULTIES.map((difficulty) => AI_SEARCH_PLANS[difficulty].topK),
    [2, 4, 6],
    "a stronger tier resolves more lines through the state transition",
  );
});

test("hillstrike ai: every action it takes is one the engine would accept", () => {
  for (const seed of [1, 42, 424242]) {
    const state = stateWithBotToPlay(seed);
    for (const difficulty of AI_DIFFICULTIES) {
      const action = chooseAiAction({ state, seat: AI_SEAT, difficulty, random: neverSlips });
      assert.deepEqual(validateAction(state, AI_SEAT, action), { ok: true });

      const applied = applyAction(state, AI_SEAT, action);
      assert.equal(applied.state.turnIndex, state.turnIndex + 1);
      if (action.type === ACTION_TYPES.SHOOT) {
        const record = applied.state.lastAction;
        const expected = hpOf(state, HUMAN_SEAT) - hpOf(applied.state, HUMAN_SEAT);
        assert.equal(record.damage, expected, "the recorded damage is the HP actually lost");
      }
    }
  }
});

test("hillstrike ai: tie-breaking is a total order, so a plan never wobbles", () => {
  const make = (score, distance, angleDeg, power) => ({
    shot: { angleDeg, power },
    impact: { tick: 1, x: 0, y: 0, kind: IMPACT_KINDS.TERRAIN, target: null },
    distance,
    score,
    lethal: false,
    damage: 0,
    enemyBlocksLost: 0,
    ownBlocksLost: 0,
  });
  const a = make(500, 100, 40, 80);
  const b = make(500, 100, 44, 80);
  const c = make(500, 100, 40, 90);
  const d = make(500, 40, 60, 60);

  assert.equal(compareAiScores(a, a), 0);
  assert.ok(compareAiScores(a, b) < 0, "lower angle wins a tie");
  assert.ok(compareAiScores(b, a) > 0, "and the order is antisymmetric");
  assert.ok(compareAiScores(c, a) < 0, "higher power wins the next tie");
  assert.ok(compareAiScores(d, a) < 0, "closer to the defender wins before either");

  const x = make(600, 50, 40, 80);
  const y = make(500, 100, 40, 80);
  const z = make(500, 200, 40, 80);
  assert.ok(compareAiScores(x, y) < 0);
  assert.ok(compareAiScores(y, z) < 0);
  assert.ok(compareAiScores(x, z) < 0);
});

test("hillstrike ai: a direct hit outranks breaking cover, which outranks bare ground", () => {
  const state = stateWithBotToPlay(424242);
  const scores = aiAimGrid("hard", AI_SEAT)
    .map((shot) => scoreAiShot({ state, seat: AI_SEAT, shot }))
    .filter(Boolean);

  const direct = scores.filter((entry) => entry.impact.kind === IMPACT_KINDS.PLAYER);
  const blocks = scores.filter((entry) => entry.impact.kind === IMPACT_KINDS.BLOCK);
  const ground = scores.filter((entry) => entry.impact.kind === IMPACT_KINDS.TERRAIN);
  assert.ok(direct.length > 0 && blocks.length > 0 && ground.length > 0, "all three are reachable");

  const best = (list) => list.map((entry) => entry.score).reduce((x, y) => Math.max(x, y));
  const worst = (list) => list.map((entry) => entry.score).reduce((x, y) => Math.min(x, y));
  assert.ok(worst(direct) > best(blocks), "a direct hit always beats a structural hit");
  assert.ok(worst(blocks) > best(ground), "breaking cover always beats an open crater");

  const byDistance = [...blocks].sort((x, y) => compareAiScores(x, y));
  assert.ok(byDistance[0].distance <= byDistance[byDistance.length - 1].distance + 1e-6);
});

test("hillstrike ai: HP decides how much a knockout shot and its own cover are worth", () => {
  const state = stateWithBotToPlay(424242);
  const hit = aiAimGrid("hard", AI_SEAT)
    .map((shot) => scoreAiShot({ state, seat: AI_SEAT, shot }))
    .find((entry) => entry && entry.impact.kind === IMPACT_KINDS.PLAYER);
  assert.ok(hit, "the layout offers a direct hit");

  const withDefenderHp = (hp) =>
    scoreAiShot({
      state: { ...state, hp: { player1: hp, player2: hpOf(state, AI_SEAT) } },
      seat: AI_SEAT,
      shot: hit.shot,
    });
  const healthy = withDefenderHp(MAX_HP);
  assert.ok(healthy.damage >= 1 && healthy.damage <= HIT_DAMAGE_MAX);
  assert.equal(healthy.lethal, false);

  const nearlyOut = withDefenderHp(1);
  assert.equal(nearlyOut.lethal, true, "the bot knows this shot would win the match");
  assert.ok(nearlyOut.score > healthy.score, "a knockout is worth more than a damaging hit");

  // A shot that fells the bot's own cover is scored down harder the closer the
  // bot is to being knocked out.
  const ownHit = aiAimGrid("hard", AI_SEAT)
    .map((shot) => scoreAiShot({ state, seat: AI_SEAT, shot }))
    .filter(Boolean)
    .find((entry) => entry.ownBlocksLost > 0);
  if (ownHit) {
    const scoreWith = (ownHp) =>
      scoreAiShot({
        state: { ...state, hp: { player1: hpOf(state, HUMAN_SEAT), player2: ownHp } },
        seat: AI_SEAT,
        shot: ownHit.shot,
      }).score;
    assert.ok(scoreWith(10) < scoreWith(MAX_HP), "low HP makes losing cover worse");
  }
});

test("hillstrike ai: it plans with the match's projectile, never a private one", () => {
  const slow = Object.freeze({
    ...createProjectileSpec(),
    launchSpeedMin: 2,
    launchSpeedMax: 11,
  });
  const seed = 424242;
  const state = createInitialState({ seed, openingSeat: HUMAN_SEAT, projectile: slow });
  const botState = applyAction(state, HUMAN_SEAT, {
    type: ACTION_TYPES.SHOOT,
    angleDeg: 45,
    power: 100,
  }).state;
  assert.deepEqual(botState.projectile, slow, "the match carries its own spec");

  const fastState = createInitialState({ seed, openingSeat: HUMAN_SEAT });
  const fastBotState = applyAction(fastState, HUMAN_SEAT, {
    type: ACTION_TYPES.SHOOT,
    angleDeg: 45,
    power: 100,
  }).state;

  const slowAction = chooseAiAction({ state: botState, seat: AI_SEAT, difficulty: "normal", random: neverSlips });
  const fastAction = chooseAiAction({ state: fastBotState, seat: AI_SEAT, difficulty: "normal", random: neverSlips });
  assert.equal(slowAction.type, ACTION_TYPES.SHOOT);
  assert.equal(fastAction.type, ACTION_TYPES.SHOOT);
  assert.notDeepEqual(slowAction, fastAction, "a slower projectile demands a different aim");

  const scoreUnder = (state, shot) => scoreAiShot({ state, seat: AI_SEAT, shot }).score;
  assert.ok(
    scoreUnder(botState, slowAction) >= scoreUnder(botState, fastAction),
    "the bot must optimise against the projectile the match actually fires",
  );
  assert.ok(scoreUnder(fastBotState, fastAction) >= scoreUnder(fastBotState, slowAction));
});

test("hillstrike ai: it reads only the documented public state", () => {
  const state = stateWithBotToPlay(31337);
  const publicKeys = new Set(AI_PUBLIC_STATE_KEYS);
  const reads = [];
  const guarded = new Proxy(state, {
    get(target, property, receiver) {
      if (typeof property === "string") {
        reads.push(property);
        if (!publicKeys.has(property)) {
          throw new Error(`the bot read a non-public field: ${property}`);
        }
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const action = chooseAiAction({ state: guarded, seat: AI_SEAT, difficulty: "hard", random: neverSlips });
  assert.ok([ACTION_TYPES.SHOOT, ACTION_TYPES.MOVE, ACTION_TYPES.BUILD].includes(action.type));
  assert.ok(reads.length > 0, "the guard really observed the read");
  for (const key of reads) assert.ok(publicKeys.has(key), `${key} must be public`);

  for (const key of Object.keys(state)) {
    assert.ok(publicKeys.has(key), `${key} must be declared public`);
  }
});
