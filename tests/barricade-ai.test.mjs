/**
 * barricade-ai.test.mjs
 *
 * The free-practice Barricade opponent, pinned.
 *
 * The point of this suite is not that the bot plays WELL — it is that it plays
 * FAIRLY and does not stall the board:
 *
 *   1. every action it ever returns is accepted by the rules engine's own
 *      validator (there is no second rulebook for bots),
 *   2. complete matches finish at all three tiers, with the engine's invariants
 *      intact at every ply,
 *   3. the tiers are actually different — Easy is beatable, Hard is not easy,
 *   4. a turn is bounded in both nodes and milliseconds, so the UI cannot hang,
 *   5. the same seed replays the same match (so a bug can be reproduced).
 *
 * Run:  node --import tsx --test tests/barricade-ai.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  AI_MAX_NODES,
  BARRICADE_TIER_HINTS,
  chooseAiAction,
  shortestRoute,
  wallCandidates,
} from "../src/lib/barricade/ai.ts";
import {
  applyAction,
  classifyWall,
  createInitialState,
  distanceToGoal,
  isMatchFinished,
  legalActions,
  legalMoves,
  otherSeat,
  positionKey,
  validateAction,
  wallKey,
} from "../src/lib/barricade/rules.ts";
import { AI_DIFFICULTIES } from "../src/lib/aiDifficulty.ts";

const TIERS = ["easy", "normal", "hard"];

/* -------------------------------------------------------------------------- *
 * Helpers
 * -------------------------------------------------------------------------- */

/** Deterministic PRNG (mulberry32) so every simulation is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function actionKey(action) {
  return action.type === "wall" ? `w:${wallKey(action.wall)}` : `m:${positionKey(action.to)}`;
}

function stateWith(overrides) {
  const base = createInitialState();
  const { pawns, walls = [], wallsRemaining = {}, turn, status } = overrides;
  return {
    ...base,
    status: status ?? base.status,
    turn: turn ?? base.turn,
    pawns: { ...base.pawns, ...pawns },
    walls,
    wallsRemaining: { ...base.wallsRemaining, ...wallsRemaining },
  };
}

/**
 * The human stand-in used to play whole matches: a competent racer. It walks the
 * shortest route and, when the bot is ahead of it, spends a barricade on the
 * bot's own route. That is enough to beat a weak tier and to be punished by a
 * strong one.
 */
function humanAction(state, random, placeWalls = true) {
  const seat = state.turn;
  const opponent = otherSeat(seat);
  const moves = legalMoves(state, seat);
  if (placeWalls && state.wallsRemaining[seat] > 0) {
    const lead = distanceToGoal(state, opponent) - distanceToGoal(state, seat);
    if (lead <= -1) {
      const blocking = wallCandidates(state, seat, 8)
        .map((wall) => {
          const next = applyAction(state, seat, { type: "wall", wall });
          return {
            wall,
            gain: distanceToGoal(next, opponent) - distanceToGoal(state, opponent),
          };
        })
        .filter((entry) => entry.gain >= 1)
        .sort((a, b) => b.gain - a.gain);
      if (blocking.length > 0 && random() < 0.6) {
        return { type: "wall", wall: blocking[0].wall };
      }
    }
  }
  const route = shortestRoute(state, seat);
  const nextStep = route.length > 1 ? positionKey(route[1]) : null;
  const direct = moves.find((action) => positionKey(action.to) === nextStep);
  if (direct) return direct;
  const scored = moves
    .map((action) => ({ action, distance: distanceToGoal(applyAction(state, seat, action), seat) }))
    .sort((a, b) => a.distance - b.distance);
  return scored[0].action;
}

/** Play one complete match: the human racer versus `tier`. */
function playMatch({ seed, tier, humanSeat = "player1", humanPlacesWalls = true, maxPlies = 400 }) {
  const random = mulberry32(seed);
  const aiRandom = mulberry32(seed * 7919 + 13);
  let state = createInitialState();
  let plies = 0;
  const events = [];

  while (!isMatchFinished(state) && plies < maxPlies) {
    const seat = state.turn;
    const action =
      seat === humanSeat
        ? humanAction(state, random, humanPlacesWalls)
        : chooseAiAction(state, seat, tier, { random: aiRandom });

    assert.ok(action, `tier ${tier} seed ${seed}: the bot must produce an action`);
    // The engine is the referee for BOTH sides — the bot gets no special rules.
    const verdict = validateAction(state, seat, action);
    assert.equal(verdict.ok, true, `tier ${tier} seed ${seed}: ${JSON.stringify(action)}`);
    assert.ok(
      legalActions(state).some((legal) => actionKey(legal) === actionKey(action)),
      `tier ${tier} seed ${seed}: the bot must pick from the legal menu`,
    );

    state = applyAction(state, seat, action);
    events.push({ seat, key: actionKey(action) });
    plies += 1;
  }

  return { state, plies, events };
}

/* -------------------------------------------------------------------------- *
 * 1. Every action the bot returns is engine-legal
 * -------------------------------------------------------------------------- */

test("barricade ai: every tier only ever returns an action the engine accepts", () => {
  const random = mulberry32(4242);
  let checked = 0;

  // A spread of positions: fresh boards, mid-games and barricade-heavy boards.
  for (let game = 0; game < 3; game += 1) {
    let state = createInitialState();
    for (let ply = 0; ply < 20 && !isMatchFinished(state); ply += 1) {
      const seat = state.turn;
      for (const tier of TIERS) {
        const action = chooseAiAction(state, seat, tier, { random });
        assert.ok(action, `tier ${tier} must answer`);
        assert.deepEqual(validateAction(state, seat, action), { ok: true, kind: action.type === "wall" ? "wall" : action.kind });
        assert.doesNotThrow(() => applyAction(state, seat, action));
        checked += 1;
      }
      // Advance the game with the hard tier so the positions stay realistic.
      state = applyAction(state, seat, chooseAiAction(state, seat, "hard", { random }));
    }
  }
  assert.ok(checked > 120, `expected a broad sweep, only checked ${checked}`);
});

test("barricade ai: a tier with nothing to choose returns nothing instead of inventing one", () => {
  const state = createInitialState(); // player1 to move
  assert.equal(chooseAiAction(state, "player2", "hard"), null, "not the bot's turn yet");

  // Player1 walks home: the match is over, so nobody has a turn.
  const nearlyDone = stateWith({
    pawns: { player1: { col: 4, row: 7 }, player2: { col: 4, row: 0 } },
    turn: "player1",
  });
  const finished = applyAction(nearlyDone, "player1", { type: "move", to: { col: 4, row: 8 } });
  assert.equal(finished.status, "finished");
  assert.equal(chooseAiAction(finished, finished.turn, "hard"), null);
  assert.equal(chooseAiAction(finished, "player2", "hard"), null);
});

test("barricade ai: unknown difficulty spellings fall back to the shared scale", () => {
  const state = createInitialState();
  // The bot plays as player2, so give it the turn.
  const opened = applyAction(state, "player1", { type: "move", to: { col: 4, row: 1 } });
  for (const spelling of ["medium", "casual", "expert", 3, null, "nonsense"]) {
    const action = chooseAiAction(opened, "player2", spelling);
    assert.ok(action, `spelling ${JSON.stringify(spelling)} must still produce a move`);
    assert.equal(validateAction(opened, "player2", action).ok, true);
  }
});

test("barricade ai: the bot never mutates the position it was handed", () => {
  const random = mulberry32(99);
  let state = createInitialState();
  for (let ply = 0; ply < 12; ply += 1) {
    state = applyAction(state, state.turn, chooseAiAction(state, state.turn, "hard", { random }));
  }
  const before = JSON.stringify(state);
  for (const tier of TIERS) {
    chooseAiAction(state, state.turn, tier, { random });
    assert.equal(JSON.stringify(state), before);
  }
});

/* -------------------------------------------------------------------------- *
 * 2. Complete matches finish at every tier
 * -------------------------------------------------------------------------- */

test("barricade ai: complete matches finish at every tier, invariants intact", () => {
  for (const tier of TIERS) {
    for (const seed of [3, 17]) {
      const { state, plies } = playMatch({ seed, tier });

      assert.equal(isMatchFinished(state), true, `tier ${tier} seed ${seed} must finish`);
      assert.ok(state.winner === "player1" || state.winner === "player2");
      assert.equal(state.outcome.winner, state.winner);
      assert.equal(state.outcome.reason, "reached-baseline");
      assert.ok(plies <= 400);
      assert.equal(state.ply, plies);
      assert.equal(state.walls.length <= 20, true);
      assert.equal(state.wallsRemaining.player1 >= 0, true);
      assert.equal(state.wallsRemaining.player2 >= 0, true);
      assert.equal(
        state.wallsRemaining.player1 + state.wallsRemaining.player2,
        20 - state.walls.length,
      );
      assert.deepEqual(legalActions(state), []);
    }
  }
});

test("barricade ai: a bot match is reproducible from the same seed", () => {
  const first = playMatch({ seed: 2026, tier: "hard" });
  const second = playMatch({ seed: 2026, tier: "hard" });
  assert.equal(first.plies, second.plies);
  assert.equal(first.state.winner, second.state.winner);
  assert.deepEqual(first.events, second.events);
});

/* -------------------------------------------------------------------------- *
 * 3. The tiers are actually different
 * -------------------------------------------------------------------------- */

test("barricade ai: Easy is beatable and clearly weaker than Hard", () => {
  const seeds = Array.from({ length: 10 }, (_, index) => index * 31 + 5);
  const wins = { easy: 0, normal: 0, hard: 0 };
  for (const tier of TIERS) {
    for (const seed of seeds) {
      const { state } = playMatch({ seed, tier });
      if (state.winner === "player1") wins[tier] += 1;
    }
  }

  // A competent racer should take most games off Easy...
  assert.ok(wins.easy >= 6, `Easy should be beatable (won ${wins.easy}/${seeds.length})`);
  // ...and noticeably fewer off Hard.
  assert.ok(
    wins.easy > wins.hard,
    `Easy (${wins.easy}) must be weaker than Hard (${wins.hard}) over the same seeds`,
  );
  // Normal sits on the shared scale between them.
  assert.ok(
    wins.easy >= wins.normal && wins.normal >= wins.hard,
    `tiers must be ordered: easy ${wins.easy} ≥ normal ${wins.normal} ≥ hard ${wins.hard}`,
  );
});

/** A random source that never slips, so a tier plays its preferred action. */
const NEVER_SLIPS = () => 0.99;

test("barricade ai: every tier reacts to a one-move threat by blocking the goal", () => {
  // The human pawn is one step from its goal; the bot is far away and to move.
  const state = stateWith({
    pawns: { player1: { col: 4, row: 7 }, player2: { col: 0, row: 7 } },
    turn: "player2",
  });
  assert.equal(distanceToGoal(state, "player1"), 1);
  assert.equal(distanceToGoal(state, "player2"), 7);

  for (const tier of TIERS) {
    const action = chooseAiAction(state, "player2", tier, { random: NEVER_SLIPS });
    assert.equal(action.type, "wall", `tier ${tier} must block, not race`);
    const next = applyAction(state, "player2", action);
    assert.ok(
      distanceToGoal(next, "player1") > 1,
      `tier ${tier}: the barricade must actually slow the goal-bound pawn`,
    );
    assert.ok(distanceToGoal(next, "player2") <= distanceToGoal(state, "player2"));
  }
});

test("barricade ai: every tier takes an immediate win instead of a clever barricade", () => {
  // The bot can step onto its goal row right now, while a barricade would also
  // look tempting (the human is one step away too). Winning is the only answer.
  const state = stateWith({
    pawns: { player1: { col: 0, row: 7 }, player2: { col: 4, row: 1 } },
    turn: "player2",
  });

  for (const tier of TIERS) {
    const action = chooseAiAction(state, "player2", tier, { random: NEVER_SLIPS });
    assert.equal(action.type, "move", `tier ${tier} must take the win`);
    assert.deepEqual(action.to, { col: 4, row: 0 });
    assert.equal(applyAction(state, "player2", action).winner, "player2");
  }
});

test("barricade ai: Easy advances rather than spending a barricade at parity", () => {
  // Wide open board: Easy is level with the human, so it pushes its pawn rather
  // than burning one of its ten barricades (the strong tiers are free to block —
  // that is real Barricade strategy — Easy is not supposed to be clever).
  const fresh = stateWith({ turn: "player2" });
  const action = chooseAiAction(fresh, "player2", "easy", { random: NEVER_SLIPS });
  assert.equal(action.type, "move");
  assert.equal(distanceToGoal(applyAction(fresh, "player2", action), "player2"), 7);
});

test("barricade ai: a tier with no barricades left just races", () => {
  const state = stateWith({ turn: "player2", wallsRemaining: { player2: 0 } });
  for (const tier of TIERS) {
    const action = chooseAiAction(state, "player2", tier, { random: NEVER_SLIPS });
    assert.equal(action.type, "move", `tier ${tier} should advance`);
    assert.equal(
      distanceToGoal(applyAction(state, "player2", action), "player2"),
      7,
      `tier ${tier} must walk towards the goal`,
    );
  }
});

test("barricade ai: the bot plays either seat, and the wall candidates are real", () => {
  // Same position, roles swapped: the bot must behave the same way as player1.
  const state = stateWith({
    pawns: { player1: { col: 0, row: 1 }, player2: { col: 4, row: 7 } },
    turn: "player1",
  });
  const action = chooseAiAction(state, "player1", "hard", { random: mulberry32(7) });
  assert.equal(action.type, "wall");
  assert.ok(distanceToGoal(applyAction(state, "player1", action), "player2") > 1);

  // Candidates come from the opponent's own route and are engine-validated.
  const candidates = wallCandidates(state, "player1", 12);
  assert.ok(candidates.length > 0);
  assert.equal(new Set(candidates.map(wallKey)).size, candidates.length);
  for (const wall of candidates) {
    assert.equal(classifyWall(state, "player1", wall).ok, true, wallKey(wall));
  }
});

test("barricade ai: an exhausted reserve falls back to pawn moves", () => {
  const state = stateWith({
    pawns: { player1: { col: 4, row: 7 }, player2: { col: 0, row: 1 } },
    wallsRemaining: { player2: 0 },
    turn: "player2",
  });
  assert.deepEqual(wallCandidates(state, "player2", 8), []);
  for (const tier of TIERS) {
    const action = chooseAiAction(state, "player2", tier, { random: mulberry32(3) });
    assert.equal(action.type, "move", `tier ${tier} must move when out of barricades`);
    assert.equal(validateAction(state, "player2", action).ok, true);
  }
});

/* -------------------------------------------------------------------------- *
 * 4. A turn is bounded — the board can never hang
 * -------------------------------------------------------------------------- */

test("barricade ai: a turn stays inside its node and time budget", () => {
  const random = mulberry32(1234567);
  const worst = { easy: 0, normal: 0, hard: 0 };
  let turns = 0;

  for (let game = 0; game < 2; game += 1) {
    let state = createInitialState();
    while (!isMatchFinished(state) && turns < 240) {
      for (const tier of TIERS) {
        const started = performance.now();
        const action = chooseAiAction(state, state.turn, tier, { random });
        const elapsed = performance.now() - started;
        worst[tier] = Math.max(worst[tier], elapsed);
        assert.ok(action);
        turns += 1;
      }
      state = applyAction(state, state.turn, chooseAiAction(state, state.turn, "hard", { random }));
    }
  }

  assert.ok(turns >= 120, `expected a long hour of play, only ${turns} turns`);
  // Generous versus the module's own 45 ms deadline, and far below a frame
  // budget's worth of stall: this is the "no UI freeze" guarantee.
  for (const tier of TIERS) {
    assert.ok(worst[tier] < 120, `tier ${tier} worst turn ${worst[tier].toFixed(1)} ms`);
  }
  assert.ok(AI_MAX_NODES > 0 && AI_MAX_NODES <= 1000);
});

test("barricade ai: an impossible deadline still yields a legal action", () => {
  const random = mulberry32(77);
  let state = createInitialState();
  for (let ply = 0; ply < 20; ply += 1) {
    const seat = state.turn;
    const action =
      seat === "player1"
        ? chooseAiAction(state, seat, "easy", { random })
        : chooseAiAction(state, seat, "hard", { random, deadlineMs: 0 });
    assert.ok(action, `ply ${ply} must still answer`);
    assert.equal(validateAction(state, seat, action).ok, true);
    state = applyAction(state, seat, action);
  }
});

/* -------------------------------------------------------------------------- *
 * 5. Presentation hints
 * -------------------------------------------------------------------------- */

test("barricade ai: every tier has a hint and a shared-scale label", () => {
  assert.deepEqual(Object.keys(BARRICADE_TIER_HINTS).sort(), [...AI_DIFFICULTIES].sort());
  for (const tier of AI_DIFFICULTIES) {
    assert.equal(typeof BARRICADE_TIER_HINTS[tier], "string");
    assert.ok(BARRICADE_TIER_HINTS[tier].length > 20);
  }
});
