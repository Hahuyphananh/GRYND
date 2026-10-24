/**
 * hillstrike-ai.test.mjs — Phase 3's bot contract.
 *
 * The practice bot is the ONLY opponent in Hillstrike, so its honesty is a
 * gameplay property, not a detail: difficulty may change how carefully it
 * PICKS a shot and nothing else. This suite pins that:
 *
 *   • it returns a plain `{ angleDeg, power }` — no projectile, no damage
 *     modifier, no hidden bonus, nothing that could make a "hard" bot hit
 *     harder than a "easy" one;
 *   • every candidate it considers is resolved by the SAME `simulateShot` and
 *     the SAME projectile spec the match uses;
 *   • a stronger tier aims better (more direct hits), never shoots further;
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
  chooseAiShot,
  compareAiScores,
  HILLSTRIKE_TIER_HINTS,
  scoreAiShot,
} from "../src/lib/hillstrike/ai.ts";
import { IMPACT_KINDS, MATCH_STATUS, POWER_MAX } from "../src/lib/hillstrike/constants.ts";
import { createProjectileSpec, simulateShot } from "../src/lib/hillstrike/physics.ts";
import { applyShot, createInitialState, validateShot } from "../src/lib/hillstrike/rules.ts";
import { AI_DIFFICULTIES, coerceAiDifficulty } from "../src/lib/aiDifficulty.ts";

const SEATS = ["player1", "player2"];
const AI_SEAT = "player2";
const HUMAN_SEAT = "player1";

/** A state where the bot owns the turn (the only state a caller may ask in). */
function stateWithBotToPlay(seed, { openingSeat = HUMAN_SEAT } = {}) {
  const fresh = createInitialState({ seed, openingSeat });
  // Hand the turn to the bot through the engine, never by editing the state: an
  // opening shot by the human (or, when the bot opens, none at all).
  if (openingSeat === HUMAN_SEAT) {
    const lob = { angleDeg: 45, power: 100 };
    const next = applyShot(fresh, HUMAN_SEAT, lob).state;
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

test("hillstrike ai: the bot returns an aim, and nothing but an aim", () => {
  for (const seed of [1, 7, 42, 424242]) {
    const state = stateWithBotToPlay(seed);
    for (const difficulty of AI_DIFFICULTIES) {
      const shot = chooseAiShot({ state, seat: AI_SEAT, difficulty, random: neverSlips });
      assert.deepEqual(
        Object.keys(shot).sort(),
        ["angleDeg", "power"],
        "a bot shot may only carry an angle and a power",
      );
      assert.equal(Number.isFinite(shot.angleDeg), true);
      assert.equal(Number.isInteger(shot.power), true);
      assert.ok(shot.power >= 0 && shot.power <= POWER_MAX, `power ${shot.power} is in range`);
      // The bot fires backwards/forwards correctly: player2 shoots to the left.
      assert.ok(shot.angleDeg > 90 && shot.angleDeg <= 180, `angle ${shot.angleDeg} faces left`);
    }
  }
});

test("hillstrike ai: difficulty changes the AIM, never the projectile or the physics", () => {
  const seed = 987654;
  const state = stateWithBotToPlay(seed);

  // Every tier resolves through the same spec the state carries...
  for (const difficulty of AI_DIFFICULTIES) {
    const shot = chooseAiShot({ state, seat: AI_SEAT, difficulty, random: neverSlips });
    const viaState = resolve(state, AI_SEAT, shot);
    const viaExplicit = simulateShot({
      battlefield: state.battlefield,
      shooterSeat: AI_SEAT,
      shot,
      projectile: state.projectile,
    }).impact;
    assert.deepEqual(viaState, viaExplicit, "the same shot through the same physics");
    assert.ok(
      Object.values(IMPACT_KINDS).includes(viaState.kind),
      `impact kind ${viaState.kind} is a real one`,
    );
  }

  // ...and the shot itself is chosen by a tier-specific SEARCH: a stronger tier
  // never scores worse than a weaker one on the same position.
  const hits = (difficulty) => {
    const shot = chooseAiShot({ state, seat: AI_SEAT, difficulty, random: neverSlips });
    return resolve(state, AI_SEAT, shot);
  };
  const easy = hits("easy");
  const hard = hits("hard");
  const distance = (impact) => {
    const defender = state.battlefield.players[HUMAN_SEAT];
    return Math.hypot(impact.x - defender.x, impact.y - defender.y);
  };
  assert.ok(
    hard.kind === IMPACT_KINDS.PLAYER || distance(hard) <= distance(easy) + 1e-6,
    `hard (${hard.kind}, ${distance(hard).toFixed(1)}px) should aim at least as well as easy ` +
      `(${easy.kind}, ${distance(easy).toFixed(1)}px)`,
  );
});

test("hillstrike ai: a stronger tier lands more direct hits across seeds", () => {
  const seeds = [3, 11, 29, 101, 555, 4242, 9001, 31337];
  const directHits = (difficulty) =>
    seeds.filter((seed) => {
      const state = stateWithBotToPlay(seed);
      const shot = chooseAiShot({ state, seat: AI_SEAT, difficulty, random: neverSlips });
      return resolve(state, AI_SEAT, shot).kind === IMPACT_KINDS.PLAYER;
    }).length;

  const easy = directHits("easy");
  const hard = directHits("hard");
  assert.ok(hard >= easy, `hard (${hard}/${seeds.length}) must not be worse than easy (${easy}/${seeds.length})`);
  assert.ok(hard >= seeds.length / 2, `hard should solve most layouts (got ${hard}/${seeds.length})`);
});

test("hillstrike ai: the bot is deterministic for a given random stream", () => {
  const state = stateWithBotToPlay(424242);

  // No slip: the same call twice is the same shot.
  for (const difficulty of AI_DIFFICULTIES) {
    const once = chooseAiShot({ state, seat: AI_SEAT, difficulty, random: neverSlips });
    const twice = chooseAiShot({ state, seat: AI_SEAT, difficulty, random: neverSlips });
    assert.deepEqual(twice, once, `${difficulty} repeats itself`);
  }

  // A seeded stream repeats exactly, and a slip is a different (worse) line.
  const streamed = (values) => {
    let index = 0;
    return () => values[index++ % values.length];
  };
  const first = chooseAiShot({
    state,
    seat: AI_SEAT,
    difficulty: "easy",
    random: streamed([0.99, 0.5, 0.25]),
  });
  const second = chooseAiShot({
    state,
    seat: AI_SEAT,
    difficulty: "easy",
    random: streamed([0.99, 0.5, 0.25]),
  });
  assert.deepEqual(second, first);

  const slipped = chooseAiShot({
    state,
    seat: AI_SEAT,
    difficulty: "easy",
    random: streamed([0, 0, 0]),
  });
  const best = chooseAiShot({ state, seat: AI_SEAT, difficulty: "easy", random: neverSlips });
  assert.notDeepEqual(slipped, best, "an easy tier slip picks a different line");
});

test("hillstrike ai: the bot refuses to plan out of turn or after the match", () => {
  const state = stateWithBotToPlay(77);

  assert.throws(
    () => chooseAiShot({ state, seat: HUMAN_SEAT, difficulty: "normal" }),
    /not this seat's turn/,
  );
  assert.throws(() => chooseAiShot({ state, seat: "player3", difficulty: "normal" }), TypeError);
  assert.throws(() => chooseAiShot({ state: null, seat: AI_SEAT, difficulty: "normal" }), TypeError);

  // A finished match has no shot to pick: the engine's winner is final.
  const finished = Object.freeze({
    ...state,
    status: MATCH_STATUS.FINISHED,
    lives: { player1: 3, player2: 0 },
    winner: HUMAN_SEAT,
    terminationReason: "lives-exhausted",
  });
  assert.throws(
    () => chooseAiShot({ state: finished, seat: AI_SEAT, difficulty: "normal" }),
    /already over/,
  );
});

test("hillstrike ai: planning never mutates the authoritative state", () => {
  const state = stateWithBotToPlay(2024);
  const before = JSON.stringify(state);
  for (const difficulty of AI_DIFFICULTIES) {
    chooseAiShot({ state, seat: AI_SEAT, difficulty, random: neverSlips });
  }
  assert.equal(JSON.stringify(state), before, "the bot is a pure function of the state");
});

test("hillstrike ai: cost is bounded and an unknown tier cannot crash a match", () => {
  const state = stateWithBotToPlay(8888);

  // Hard is the widest search. It is synchronous, so a generous ceiling still
  // proves it is bounded rather than unbounded (each candidate is a sub-ms sim).
  const startedAt = process.hrtime.bigint();
  for (let repeat = 0; repeat < 5; repeat++) {
    chooseAiShot({ state, seat: AI_SEAT, difficulty: "hard", random: neverSlips });
  }
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.ok(elapsedMs < 5000, `five hard plans took ${elapsedMs.toFixed(0)}ms`);

  // An unknown tier (a stale stored preference) falls back to normal and fails
  // nowhere — it can never hand the bot a stronger line by accident.
  const unknown = chooseAiShot({
    state,
    seat: AI_SEAT,
    difficulty: "impossible",
    random: neverSlips,
  });
  const normal = chooseAiShot({ state, seat: AI_SEAT, difficulty: "normal", random: neverSlips });
  assert.deepEqual(unknown, normal);
  assert.equal(coerceAiDifficulty("impossible"), "normal");
});

test("hillstrike ai: every tier is explained in the shared vocabulary", () => {
  for (const difficulty of AI_DIFFICULTIES) {
    assert.equal(typeof HILLSTRIKE_TIER_HINTS[difficulty], "string");
    assert.ok(HILLSTRIKE_TIER_HINTS[difficulty].length > 20, `${difficulty} has a real hint`);
  }
});

/* -------------------------------------------------------------------------- *
 * Phase 4: bounded search, one engine, deterministic ties, lives-aware aim
 * -------------------------------------------------------------------------- */

test("hillstrike ai: the search is a bounded, seat-local, monotonic grid", () => {
  for (const difficulty of AI_DIFFICULTIES) {
    for (const seat of [HUMAN_SEAT, AI_SEAT]) {
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

  // A stronger tier searches MORE: a finer angle step, more power samples, and
  // strictly more lines than the tier below it (breadth, not a better weapon).
  const angleSteps = AI_DIFFICULTIES.map((difficulty) => AI_SEARCH_PLANS[difficulty].angleStep);
  assert.deepEqual(angleSteps, [...angleSteps].sort((a, b) => b - a), "tiers refine downwards");
  assert.ok(angleSteps[0] > angleSteps[1] && angleSteps[1] > angleSteps[2]);
  const sizes = AI_DIFFICULTIES.map((difficulty) => aiAimGrid(difficulty, HUMAN_SEAT).length);
  assert.ok(sizes[0] < sizes[1] && sizes[1] < sizes[2], `grid sizes must grow (${sizes.join(" < ")})`);

  // The documented ceiling really bounds the work, and stays small.
  const budgets = AI_DIFFICULTIES.map((difficulty) => aiCandidateBudget(difficulty));
  assert.deepEqual(budgets, [23, 74, 265], "the cost ceilings are stable");
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

test("hillstrike ai: every shot it fires is one the engine would accept", () => {
  for (const seed of [1, 42, 424242]) {
    const state = stateWithBotToPlay(seed);
    for (const difficulty of AI_DIFFICULTIES) {
      const shot = chooseAiShot({ state, seat: AI_SEAT, difficulty, random: neverSlips });
      assert.deepEqual(validateShot(state, AI_SEAT, shot), { ok: true });
      // ...and the real transition accepts it too, resolving to the state the
      // bot believed it was choosing from.
      const applied = applyShot(state, AI_SEAT, shot);
      assert.equal(applied.state.turnIndex, state.turnIndex + 1);
      assert.ok(
        IMPACT_KINDS.PLAYER !== applied.state.lastShot.impact.kind ||
          applied.state.lives[HUMAN_SEAT] === state.lives[HUMAN_SEAT] - 1,
        "a resolved hit takes exactly the life the bot planned for",
      );
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
  // Transitive on scores: a better score always sorts first, whatever the ties.
  const x = make(600, 50, 40, 80);
  const y = make(500, 100, 40, 80);
  const z = make(500, 200, 40, 80);
  assert.ok(compareAiScores(x, y) < 0);
  assert.ok(compareAiScores(y, z) < 0);
  assert.ok(compareAiScores(x, z) < 0);

  // Same state, same tier, no slips: byte-identical plans, every time.
  const state = stateWithBotToPlay(555);
  const once = chooseAiShot({ state, seat: AI_SEAT, difficulty: "hard", random: neverSlips });
  const twice = chooseAiShot({ state, seat: AI_SEAT, difficulty: "hard", random: neverSlips });
  assert.deepEqual(twice, once);
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

  // Among structural hits, the one closer to the defender is preferred: that is
  // the "exposed player" part of the plan — knock the cover off the gunner.
  const byDistance = [...blocks].sort((x, y) => compareAiScores(x, y));
  assert.ok(byDistance[0].distance <= byDistance[byDistance.length - 1].distance + 1e-6);
});

test("hillstrike ai: lives decide how much a killing shot and its own cover are worth", () => {
  const state = stateWithBotToPlay(424242);
  const hit = aiAimGrid("hard", AI_SEAT)
    .map((shot) => scoreAiShot({ state, seat: AI_SEAT, shot }))
    .find((entry) => entry && entry.impact.kind === IMPACT_KINDS.PLAYER);
  assert.ok(hit, "the layout offers a direct hit");

  const withDefenderLives = (lives) =>
    scoreAiShot({
      state: { ...state, lives: { player1: lives, player2: state.lives.player2 } },
      seat: AI_SEAT,
      shot: hit.shot,
    });
  const normal = withDefenderLives(3);
  const lastLife = withDefenderLives(1);
  assert.equal(normal.lethal, false);
  assert.equal(lastLife.lethal, true, "the bot knows this shot would win the match");
  assert.ok(lastLife.score > normal.score, "a killing shot is worth more than a damaging one");

  // Own cover: a shot that demolishes the bot's own tower is a bad idea, and a
  // terrible one when that tower is the last cover it has.
  const selfDamage = aiAimGrid("hard", AI_SEAT)
    .map((shot) => scoreAiShot({ state, seat: AI_SEAT, shot }))
    .filter(Boolean)
    .find((entry) => entry.ownBlocksLost > 0 || entry.ownBlocksLost === 0 && entry.impact.kind === IMPACT_KINDS.BLOCK);
  assert.ok(selfDamage, "some line hits the bot's own side");
  const { impact } = selfDamage;
  const ownHit = aiAimGrid("hard", AI_SEAT)
    .map((shot) => scoreAiShot({ state, seat: AI_SEAT, shot }))
    .filter(Boolean)
    .filter((entry) => entry.impact.x === impact.x && entry.impact.y === impact.y)
    .sort((x, y) => y.ownBlocksLost - x.ownBlocksLost)[0];
  if (ownHit && ownHit.ownBlocksLost > 0) {
    const scoreWith = (ownLives) =>
      scoreAiShot({
        state: { ...state, lives: { player1: state.lives.player1, player2: ownLives } },
        seat: AI_SEAT,
        shot: ownHit.shot,
      }).score;
    assert.ok(
      scoreWith(1) < scoreWith(3),
      "felling your own tower on your last life is scored down harder",
    );
  }
});

test("hillstrike ai: it plans with the match's projectile, never a private one", () => {
  // A deliberately feeble projectile: the same aim cannot reach the enemy with it.
  const slow = Object.freeze({
    ...createProjectileSpec(),
    launchSpeedMin: 2,
    launchSpeedMax: 11,
  });
  const seed = 424242;
  const state = createInitialState({ seed, openingSeat: HUMAN_SEAT, projectile: slow });
  const botState = applyShot(state, HUMAN_SEAT, { angleDeg: 45, power: 100 }).state;
  assert.deepEqual(botState.projectile, slow, "the match carries its own spec");

  // The same battlefield with the canonical spec: the bot must plan DIFFERENTLY.
  const fastState = createInitialState({ seed, openingSeat: HUMAN_SEAT });
  const fastBotState = applyShot(fastState, HUMAN_SEAT, { angleDeg: 45, power: 100 }).state;

  const slowShot = chooseAiShot({ state: botState, seat: AI_SEAT, difficulty: "normal", random: neverSlips });
  const fastShot = chooseAiShot({ state: fastBotState, seat: AI_SEAT, difficulty: "normal", random: neverSlips });
  assert.notDeepEqual(slowShot, fastShot, "a slower projectile demands a different aim");

  // And its plan is the best line FOR ITS OWN SPEC: the shot the fast bot would
  // have chosen scores worse under the slow physics.
  const scoreUnder = (state, shot) => scoreAiShot({ state, seat: AI_SEAT, shot }).score;
  assert.ok(
    scoreUnder(botState, slowShot) >= scoreUnder(botState, fastShot),
    "the bot must optimise against the projectile the match actually fires",
  );
  // Sanity: under the real spec that same slow-physics aim is not the best line.
  assert.ok(scoreUnder(fastBotState, fastShot) >= scoreUnder(fastBotState, slowShot));
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

  const shot = chooseAiShot({ state: guarded, seat: AI_SEAT, difficulty: "hard", random: neverSlips });
  assert.equal(Number.isFinite(shot.angleDeg), true);
  assert.ok(reads.length > 0, "the guard really observed the read");
  for (const key of reads) assert.ok(publicKeys.has(key), `${key} must be public`);

  // The projection is the whole match state (Hillstrike has no secret state), so
  // this list is also the complete answer to "what may a bot know?".
  for (const key of Object.keys(state)) {
    assert.ok(publicKeys.has(key), `${key} must be declared public`);
  }
});
