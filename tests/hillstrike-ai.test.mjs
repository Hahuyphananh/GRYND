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
  BATTLEFIELD_WIDTH,
  HIT_DAMAGE_MAX,
  IMPACT_KINDS,
  LAUNCHER_INSET_X,
  MATCH_STATUS,
  MAX_HP,
  MOVE_STEP,
  POWER_MAX,
  POWERUP_CHASE_DRIVES,
  STRUCTURE_BLOCK_SIZE,
} from "../src/lib/hillstrike/constants.ts";
import { createProjectileSpec, simulateShot } from "../src/lib/hillstrike/physics.ts";
import { surfaceYAt } from "../src/lib/hillstrike/generation.ts";
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

/**
 * A position where BOTH tanks have driven out from under their base roofs.
 *
 * From the spawn the only line the engine can offer is into the player's own
 * indestructible ceiling — that is the point of the roof — so positions where the
 * bot is expected to SHOOT have to be staged the way a real match gets there: by
 * driving. Filler actions are straight-up minimum-power shots, which the roof
 * absorbs without changing the battlefield at all.
 */
function stateInTheOpen(seed, { drives = 3, projectile } = {}) {
  let state = createInitialState({ seed, openingSeat: HUMAN_SEAT, projectile });
  const travelled = (seat) => {
    const spawn =
      seat === HUMAN_SEAT ? LAUNCHER_INSET_X : BATTLEFIELD_WIDTH - LAUNCHER_INSET_X;
    return Math.abs(state.battlefield.players[seat].x - spawn);
  };
  const atQuota = (seat) => travelled(seat) >= drives * MOVE_STEP;

  for (let guard = 0; guard < 200; guard++) {
    if (atQuota(HUMAN_SEAT) && atQuota(AI_SEAT) && state.turn === AI_SEAT) {
      return state;
    }
    const actor = state.turn;
    const canDrive =
      !atQuota(actor) &&
      validateAction(state, actor, { type: "move", direction: "forward" }).ok;
    const action = canDrive
      ? { type: "move", direction: "forward" }
      : { type: "shoot", angleDeg: 90, power: 0 };
    state = applyAction(state, actor, action).state;
  }
  throw new Error(`could not stage an open position for seed ${seed}`);
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

/** The same board with the middle emptied, for tests that are about AIM alone. */
function withoutPickups(state) {
  return {
    ...state,
    battlefield: { ...state.battlefield, pickups: [], respawns: [] },
  };
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
        // A build names the tile it wants; the engine still derives everything
        // else about the block it will place.
        assert.deepEqual(Object.keys(action).sort(), ["type", "x", "y"]);
        assert.equal(Number.isInteger(action.x), true);
        assert.equal(Number.isInteger(action.y), true);
        assert.ok(
          AI_SEAT === "player1"
            ? action.x + STRUCTURE_BLOCK_SIZE <= BATTLEFIELD_WIDTH / 2
            : action.x >= BATTLEFIELD_WIDTH / 2,
          "the bot builds on its own half",
        );
      }

      // Whatever it picked, the engine must accept it.
      assert.deepEqual(validateAction(state, AI_SEAT, action), { ok: true });
    }
  }
});

test("hillstrike ai: difficulty changes the AIM, never the projectile or the physics", () => {
  const seed = 987654;
  // No pickups: this test is about the SHOT a tier picks, not about hard's
  // middle play (which has its own tests below).
  const state = withoutPickups(stateInTheOpen(seed));

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
    const state = withoutPickups(stateInTheOpen(seed));
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
  const state = stateInTheOpen(424242);

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

test("hillstrike ai: a direct hit outranks enemy cover, which outranks ground, which outranks a roof", () => {
  // One BREAKABLE cover block is staged on the human's half, in the bot's arc:
  // a fresh board only carries the indestructible base roofs, and the whole
  // point of this ladder is to separate "cover worth breaking" from "scenery
  // that cannot be broken".
  const base = stateInTheOpen(424242);
  const human = base.battlefield.players[HUMAN_SEAT];
  const size = STRUCTURE_BLOCK_SIZE;
  const coverX = Math.round((human.x - 3 * size) / size) * size;
  const coverY =
    surfaceYAt(base.battlefield.terrain, coverX) - size;
  const state = {
    ...base,
    battlefield: {
      ...base.battlefield,
      blocks: [
        ...base.battlefield.blocks,
        {
          id: 9001,
          seat: HUMAN_SEAT,
          kind: "cover",
          x: coverX,
          y: coverY,
          size,
          integrity: 1,
        },
      ],
    },
  };

  const scores = aiAimGrid("hard", AI_SEAT)
    .map((shot) => scoreAiShot({ state, seat: AI_SEAT, shot }))
    .filter(Boolean);
  const blockKind = new Map(state.battlefield.blocks.map((block) => [block.id, block.kind]));

  const direct = scores.filter((entry) => entry.impact.kind === IMPACT_KINDS.PLAYER);
  const cover = scores.filter(
    (entry) => entry.impact.kind === IMPACT_KINDS.BLOCK && blockKind.get(entry.impact.blockId) === "cover",
  );
  const roof = scores.filter(
    (entry) => entry.impact.kind === IMPACT_KINDS.BLOCK && blockKind.get(entry.impact.blockId) === "roof",
  );
  const ground = scores.filter((entry) => entry.impact.kind === IMPACT_KINDS.TERRAIN);
  assert.ok(
    direct.length > 0 && cover.length > 0 && roof.length > 0 && ground.length > 0,
    `all four are reachable (direct ${direct.length}, cover ${cover.length}, roof ${roof.length}, ground ${ground.length})`,
  );

  const best = (list) => list.map((entry) => entry.score).reduce((x, y) => Math.max(x, y));
  const worst = (list) => list.map((entry) => entry.score).reduce((x, y) => Math.min(x, y));
  assert.ok(worst(direct) > best(cover), "a direct hit always beats a structural hit");
  assert.ok(worst(cover) > best(ground), "breaking cover always beats an open crater");
  assert.ok(best(ground) > best(roof), "a roof cannot be broken, so it is never worth a shell");

  const byDistance = [...cover].sort((x, y) => compareAiScores(x, y));
  assert.ok(byDistance[0].distance <= byDistance[byDistance.length - 1].distance + 1e-6);
});

test("hillstrike ai: HP decides how much a knockout shot and its own cover are worth", () => {
  const state = stateInTheOpen(424242);
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
  // bot is to being knocked out. The bot's own breakable cover is staged in its
  // own half, in front of its hull.
  const own = state.battlefield.players[AI_SEAT];
  const size = STRUCTURE_BLOCK_SIZE;
  const ownX = Math.round((own.x - 2 * size) / size) * size;
  const withOwnCover = {
    ...state,
    battlefield: {
      ...state.battlefield,
      blocks: [
        ...state.battlefield.blocks,
        {
          id: 9002,
          seat: AI_SEAT,
          kind: "cover",
          x: ownX,
          y: surfaceYAt(state.battlefield.terrain, ownX) - size,
          size,
          integrity: 1,
        },
      ],
    },
  };
  const ownHit = aiAimGrid("hard", AI_SEAT)
    .map((shot) => scoreAiShot({ state: withOwnCover, seat: AI_SEAT, shot }))
    .filter(Boolean)
    .find((entry) => entry.ownBlocksLost > 0);
  assert.ok(ownHit, "the bot can hit its own cover from this position");
  const scoreWith = (ownHp) =>
    scoreAiShot({
      state: {
        ...withOwnCover,
        hp: { player1: hpOf(state, HUMAN_SEAT), player2: ownHp },
      },
      seat: AI_SEAT,
      shot: ownHit.shot,
    }).score;
  assert.ok(scoreWith(10) < scoreWith(MAX_HP), "low HP makes losing cover worse");
});

/* -------------------------------------------------------------------------- *
 * The middle: hard plays the map, not just its spawn
 * -------------------------------------------------------------------------- */

/**
 * The bot's turn with BOTH actions in hand.
 *
 * A long walk only ever spends the first action of a turn (so the second still
 * fires), which means the staged position has to be the start of a turn, not the
 * middle of one — `stateInTheOpen` can land on either. Filler shots are fired
 * straight up at zero power, which the base roof absorbs without changing the
 * battlefield at all.
 */
function botOpener(state) {
  for (
    let guard = 0;
    guard < 4 && (state.turn !== AI_SEAT || Number(state.actionsRemaining) < 2);
    guard++
  ) {
    state = applyAction(state, state.turn, { type: "shoot", angleDeg: 90, power: 0 }).state;
  }
  return state;
}

/** The same, from a fresh staged position. */
const stateWithBotOpener = (seed, options) => botOpener(stateInTheOpen(seed, options));

/** The pickup nearest the bot, and the one-action drive that closes on it. */
function nearestPickup(state, seat) {
  const player = state.battlefield.players[seat];
  const pickups = state.battlefield.pickups ?? [];
  return [...pickups].sort(
    (a, b) => Math.abs(a.x - player.x) - Math.abs(b.x - player.x) || a.id - b.id,
  )[0];
}

test("hillstrike ai: hard walks to the middle when a shell is not the better action", () => {
  const base = stateWithBotOpener(424242);
  const target = nearestPickup(base, AI_SEAT);
  assert.ok(target, "the board deals pickups");
  const bot = base.battlefield.players[AI_SEAT];
  assert.ok(
    Math.abs(target.x - bot.x) <= POWERUP_CHASE_DRIVES * MOVE_STEP,
    "the nearest lane is inside the chase budget",
  );

  // Behind on HP: the buff is the comeback, so the drive beats another shell.
  const behind = {
    ...base,
    hp: { ...base.hp, [AI_SEAT]: 40, [HUMAN_SEAT]: MAX_HP },
  };
  const hard = chooseAiAction({ state: behind, seat: AI_SEAT, difficulty: "hard", random: neverSlips });
  assert.equal(hard.type, ACTION_TYPES.MOVE, "hard walks to the power-up");
  assert.equal(
    hard.direction,
    Math.sign(target.x - bot.x) === -1 ? "forward" : "back",
    "and walks TOWARD the pickup, not away from it",
  );
  assert.deepEqual(validateAction(behind, AI_SEAT, hard), { ok: true });

  // Ahead on HP with a direct hit on the board, the shell is the better action:
  // a walk there would hand the lead back (measured, not assumed).
  const ahead = {
    ...stateWithBotOpener(424242, { drives: 2 }),
    hp: { player1: 60, player2: MAX_HP },
  };
  const trade = chooseAiAction({ state: ahead, seat: AI_SEAT, difficulty: "hard", random: neverSlips });
  assert.equal(trade.type, ACTION_TYPES.SHOOT, "ahead and hitting, hard keeps firing");
  assert.equal(
    resolve(ahead, AI_SEAT, trade).kind,
    IMPACT_KINDS.PLAYER,
    "the shell it keeps is a direct hit, so the walk really was the worse action",
  );

  // (The weaker tiers never take the middle at all: they shoot whenever they have
  // a line, which the aim test above pins for every tier.)
});

test("hillstrike ai: hard spends a buff it already carries, then goes back for the next", () => {
  const state = stateInTheOpen(424242);
  const armed = {
    ...state,
    buffs: { ...state.buffs, [AI_SEAT]: { doubleDamage: true, doubleBlast: false } },
  };
  const armedAction = chooseAiAction({
    state: armed,
    seat: AI_SEAT,
    difficulty: "hard",
    random: neverSlips,
  });
  assert.equal(
    armedAction.type,
    ACTION_TYPES.SHOOT,
    "a buff in hand is spent on a shot, never stacked by another drive",
  );
});

test("hillstrike ai: hard never trades a knockout for a power-up", () => {
  const state = stateInTheOpen(424242);
  const oneHit = { ...state, hp: { ...state.hp, [HUMAN_SEAT]: 1 } };
  const action = chooseAiAction({
    state: oneHit,
    seat: AI_SEAT,
    difficulty: "hard",
    random: neverSlips,
  });
  assert.equal(action.type, ACTION_TYPES.SHOOT, "the kill is taken while it is on the board");
  assert.equal(
    resolve(oneHit, AI_SEAT, action).kind,
    IMPACT_KINDS.PLAYER,
    "and it is a real direct hit, not a hopeful lob",
  );
});

test("hillstrike ai: hard does not chase a lane it cannot reach this match", () => {
  const state = withoutPickups(stateInTheOpen(424242));
  const action = chooseAiAction({ state, seat: AI_SEAT, difficulty: "hard", random: neverSlips });
  assert.equal(action.type, ACTION_TYPES.SHOOT, "with nothing to collect it keeps firing");
});

test("hillstrike ai: it plans with the match's projectile, never a private one", () => {
  const slow = Object.freeze({
    ...createProjectileSpec(),
    launchSpeedMin: 2,
    launchSpeedMax: 11,
  });
  const seed = 424242;
  const botState = stateInTheOpen(seed, { projectile: slow });
  assert.deepEqual(botState.projectile, slow, "the match carries its own spec");

  const fastBotState = stateInTheOpen(seed);

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
