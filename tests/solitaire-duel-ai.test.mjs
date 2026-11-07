/**
 * solitaire-duel-ai.test.mjs
 *
 * The pure Solitaire Duel practice bot, pinned.
 *
 * The bot is a heuristic solver of the shared Klondike deal, so the properties
 * that matter are: every move it chooses is LEGAL (it can never make an illegal
 * move the server would reject), it always moves on its own board, it prefers
 * the moves that make real progress, and the planner terminates instead of
 * cycling an unwinnable deal forever. `chooseAiMove` / `planAiMoves` are pure
 * and take an injectable `random`, so every one of those is drivable exactly.
 *
 * Run:  node --import tsx --test tests/solitaire-duel-ai.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  AI_MOVE_DELAY_MS,
  AI_STAGNATION_LIMIT,
  aiMoveDelayMs,
  aiPaceLabel,
  aiPaceSeconds,
  chooseAiMove,
  legalMoves,
  planAiMoves,
  planAiSolution,
} from "../src/lib/solitaire-duel/ai.ts";
import {
  solvableDealFromSeed,
  solveDealLine,
} from "../src/lib/solitaire-duel/solvable.ts";
import {
  applyMove,
  canPlaceOnTableau,
  foundationExpects,
  initialStateFromDeal,
} from "../src/lib/solitaire-duel/rules.ts";
import { dealFromSeed } from "../src/lib/solitaire-duel/deck.ts";
import { TABLEAU_COLUMNS } from "../src/lib/solitaire-duel/constants.ts";

const card = (suit, rank) => ({ suit, rank });

/** A syntactically valid board with all seven columns, so the engine accepts it. */
function emptyState(overrides = {}) {
  return {
    variant: "klondike-1",
    variantVersion: 1,
    tableau: Array.from({ length: TABLEAU_COLUMNS }, () => []),
    stock: [],
    waste: [],
    foundations: { spades: [], hearts: [], diamonds: [], clubs: [] },
    ply: 0,
    peakFoundation: 0,
    completed: false,
    completedAtMs: null,
    ...overrides,
  };
}

/** A board from the seeded deal, for the realism/fuzz cases. */
const dealState = (seed) => initialStateFromDeal(dealFromSeed(seed));

const sameMove = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── Legality (the contract the store relies on) ───────────────────────────

test("legalMoves only ever contains moves the engine accepts", () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const state = dealState(seed * 104729);
    for (const move of legalMoves(state)) {
      const applied = applyMove({ state, move });
      assert.equal(applied.ok, true, `seed ${seed}: ${JSON.stringify(move)} must apply`);
    }
  }
});

test("chooseAiMove always returns a legal move, or null only when none exist", () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    for (const difficulty of ["easy", "normal", "hard"]) {
      const state = dealState(seed * 4099);
      const moves = legalMoves(state);
      const chosen = chooseAiMove({ state, difficulty, random: () => 0.5 });
      if (moves.length === 0) {
        assert.equal(chosen, null);
      } else {
        assert.ok(chosen, `seed ${seed}/${difficulty} returned a move`);
        assert.ok(
          moves.some((move) => sameMove(move, chosen)),
          `seed ${seed}/${difficulty}: the move must be one of the legal moves`,
        );
        assert.equal(applyMove({ state, move: chosen }).ok, true);
      }
    }
  }
});

test("chooseAiMove never mutates the board it is given", () => {
  const state = dealState(12345);
  const before = JSON.stringify(state);
  chooseAiMove({ state, difficulty: "hard" });
  assert.equal(JSON.stringify(state), before);
});

// ── Strategy ──────────────────────────────────────────────────────────────

test("it takes an available foundation move above everything else", () => {
  const state = emptyState({
    tableau: [[{ card: card("spades", 1), faceUp: true }], ...Array.from({ length: 6 }, () => [])],
    stock: [card("clubs", 9), card("hearts", 2)],
  });
  assert.equal(foundationExpects(state, "spades"), 1);
  // `random` is injected for the same reason as the reveal case below: every
  // tier slips a small percentage of the time (`AI_SKILL.hard.mistakeRate` is
  // 0.08), so leaving it on Math.random failed this assertion roughly one run
  // in twelve. `() => 1` is the deterministic no-slip roll, and a slip is a
  // separate, covered case — not a weakened check.
  const chosen = chooseAiMove({ state, difficulty: "hard", random: () => 1 });
  assert.equal(chosen.kind, "tableau-to-foundation");
  assert.equal(chosen.fromColumn, 0);
  assert.deepEqual(chosen.card, card("spades", 1));
  assert.equal(chosen.suit, "spades");
});

test("it prefers a reveal move over a draw", () => {
  const state = emptyState({
    tableau: [
      [{ card: card("spades", 3), faceUp: false }, { card: card("hearts", 5), faceUp: true }],
      [{ card: card("clubs", 6), faceUp: true }],
      [],
      [],
      [],
      [],
      [],
    ],
    stock: [card("diamonds", 9)],
  });
  // Sanity: the reveal really is legal, and a draw really is available.
  assert.equal(canPlaceOnTableau(card("hearts", 5), card("clubs", 6)), true);
  assert.ok(legalMoves(state).some((move) => move.kind === "draw"));

  // `random` is injected: every tier — `hard` included — slips a small
  // percentage of the time (AI_SKILL.hard.mistakeRate = 0.08), so leaving it on
  // Math.random made this assertion fail one run in ~12. `() => 1` never rolls
  // under the mistake rate, which is the deterministic "no slip" case the
  // assertion is about; it is NOT a weakened check (a slip is what the next test
  // covers).
  const chosen = chooseAiMove({ state, difficulty: "hard", random: () => 1 });
  assert.equal(chosen.kind, "tableau-to-tableau");
  assert.equal(chosen.fromColumn, 0);
  assert.equal(chosen.toColumn, 1);
  assert.deepEqual(chosen.card, card("hearts", 5));
});

test("easy can slip to a worse legal move; hard slips far less often", () => {
  const state = emptyState({
    tableau: [
      [{ card: card("spades", 3), faceUp: false }, { card: card("hearts", 5), faceUp: true }],
      [{ card: card("clubs", 6), faceUp: true }],
      [],
      [],
      [],
      [],
      [],
    ],
    stock: [card("diamonds", 9)],
  });
  // A clean roll: every tier takes the best move (the reveal).
  const hard = chooseAiMove({ state, difficulty: "hard", random: () => 0.99 });
  assert.equal(hard.kind, "tableau-to-tableau");

  // A forced slip: easy plays a worse legal move. Hard also slips sometimes now
  // (it is the strongest tier, not a perfect one), so the rate is what is
  // compared rather than "hard never slips".
  const easy = chooseAiMove({ state, difficulty: "easy", random: () => 0 });
  assert.ok(easy, "a slip is still a move");
  assert.equal(legalMoves(state).some((move) => sameMove(move, easy)), true);
  assert.notEqual(JSON.stringify(easy), JSON.stringify(hard));

  // A deterministic roll sequence, so the empirical slip counts differ only
  // because the tiers' mistake rates differ. (A pinned roll would make every
  // tier slip, since even `hard`'s small rate is above 0.)
  const slipRate = (tier) => {
    let slips = 0;
    let seed = 12345;
    const roll = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 400; i += 1) {
      const move = chooseAiMove({ state, difficulty: tier, random: roll });
      if (move && move.kind !== "tableau-to-tableau") slips += 1;
    }
    return slips;
  };
  assert.ok(
    slipRate("easy") > slipRate("hard"),
    "easy must slip onto a worse move more often than hard",
  );
});

test("the tier only changes the pace, ordered easy → normal → hard", () => {
  assert.ok(AI_MOVE_DELAY_MS.easy > AI_MOVE_DELAY_MS.normal);
  assert.ok(AI_MOVE_DELAY_MS.normal > AI_MOVE_DELAY_MS.hard);
  assert.equal(aiMoveDelayMs("easy"), AI_MOVE_DELAY_MS.easy);
  // Unknown tiers coerce to the shared default (normal).
  assert.equal(aiMoveDelayMs("nonsense"), AI_MOVE_DELAY_MS.normal);
});

// ── The planner (what the store runs) ─────────────────────────────────────

test("planAiMoves applies exactly the moves it reports", () => {
  for (let seed = 1; seed <= 12; seed += 1) {
    const state = dealState(seed * 7919);
    const plan = planAiMoves({ state, difficulty: "hard", maxMoves: 60, random: () => 1 });
    let cursor = state;
    for (const move of plan.moves) {
      const applied = applyMove({ state: cursor, move });
      assert.equal(applied.ok, true, `seed ${seed}: every reported move must apply`);
      cursor = applied.state;
    }
    assert.deepEqual(cursor, plan.state, `seed ${seed}: replayed state must match the plan`);
    assert.ok(plan.moves.length <= 60);
  }
});

test("planAiMoves never mutates its input and stops on an exhausted deal", () => {
  const state = dealState(424242);
  const before = JSON.stringify(state);
  const plan = planAiMoves({ state, difficulty: "hard", maxMoves: 1_500, random: () => 1 });
  assert.equal(JSON.stringify(state), before, "the input board is untouched");
  // It terminates well short of the cap: an unwinnable deal must not cycle.
  assert.ok(plan.moves.length < 400, `expected a bounded plan, got ${plan.moves.length}`);
});

test("the bot always makes a move from a fresh deal", () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const plan = planAiMoves({
      state: dealState(seed * 131),
      difficulty: "hard",
      maxMoves: 20,
      random: () => 1,
    });
    assert.ok(plan.moves.length > 0, `seed ${seed}: the bot must play`);
  }
});

test("the planner reports a board with no legal move at all as stuck", () => {
  // Seven columns, each topped by a black five, with empty foundations and an
  // empty stock/waste: no five can stack on another, no foundation fits, and
  // there is no empty column to park on. Zero legal moves.
  const dead = emptyState({
    tableau: Array.from({ length: TABLEAU_COLUMNS }, () => [
      { card: card("spades", 5), faceUp: true },
    ]),
  });
  assert.deepEqual(legalMoves(dead), []);
  const plan = planAiMoves({ state: dead, difficulty: "hard", maxMoves: 40 });
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.completed, false);
  assert.equal(plan.stuck, true, "a dead board must be reported as stuck");
});

test("the planner's `stuck` is NOT the same as a dead board", () => {
  // The store keys its PLAYER re-deal on `legalMoves`, never on `stuck`:
  // `stuck` is a heuristic verdict and fires on boards that still have a move.
  // This board is seven empty columns with a stock of non-Ace, non-King cards:
  // its ONLY legal move is the draw (then the recycle), which never changes the
  // progress key, so the planner gives up after the stagnation limit. The old
  // re-deal gate treated this as "impossible" and restarted live boards.
  const state = emptyState({
    stock: [
      card("spades", 2), card("hearts", 3), card("diamonds", 4), card("clubs", 5),
      card("spades", 6), card("hearts", 7), card("diamonds", 8), card("clubs", 9),
      card("spades", 10), card("hearts", 11), card("diamonds", 12), card("clubs", 2),
      card("spades", 3), card("hearts", 4), card("diamonds", 5), card("clubs", 6),
      card("spades", 7), card("hearts", 8), card("diamonds", 9), card("clubs", 10),
      card("spades", 11), card("hearts", 12), card("diamonds", 2), card("clubs", 3),
    ],
  });
  assert.ok(legalMoves(state).length > 0, "the board is NOT dead");
  const plan = planAiMoves({
    state,
    difficulty: "hard",
    maxMoves: AI_STAGNATION_LIMIT + 8,
    random: () => 1,
  });
  assert.equal(plan.completed, false);
  assert.equal(plan.stuck, true, "the planner still gives up on a movable board");
});

test("the planner does NOT call a behind-schedule bot stuck", () => {
  // Hitting the move cap is a PACE limit, never a dead board: the store must
  // not re-deal a bot that is merely waiting on the clock.
  const plan = planAiMoves({
    state: dealState(31337),
    difficulty: "hard",
    maxMoves: 1,
    random: () => 1,
  });
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.stuck, false);
});

test("a completed board is never reported stuck", () => {
  const done = emptyState({
    foundations: {
      spades: Array.from({ length: 13 }, (_, i) => card("spades", i + 1)),
      hearts: Array.from({ length: 13 }, (_, i) => card("hearts", i + 1)),
      diamonds: Array.from({ length: 13 }, (_, i) => card("diamonds", i + 1)),
      clubs: Array.from({ length: 13 }, (_, i) => card("clubs", i + 1)),
    },
    completed: true,
    peakFoundation: 52,
  });
  const plan = planAiMoves({ state: done, difficulty: "hard" });
  assert.equal(plan.completed, true);
  assert.equal(plan.stuck, false);
});

test("a completed board yields no move", () => {
  const state = emptyState({
    foundations: {
      spades: Array.from({ length: 13 }, (_, i) => card("spades", i + 1)),
      hearts: Array.from({ length: 13 }, (_, i) => card("hearts", i + 1)),
      diamonds: Array.from({ length: 13 }, (_, i) => card("diamonds", i + 1)),
      clubs: Array.from({ length: 13 }, (_, i) => card("clubs", i + 1)),
    },
    completed: true,
    peakFoundation: 52,
  });
  assert.deepEqual(legalMoves(state), []);
  assert.equal(chooseAiMove({ state, difficulty: "hard" }), null);
  assert.equal(planAiMoves({ state, difficulty: "hard" }).moves.length, 0);
});

// ── The proven line: why the bot can no longer stall part-way ────────────
//
// The reported bug: the bot's progress froze at one percentage and the puzzle
// was never resolved. A per-move heuristic can dead-end; the deal's verified
// line cannot. These pin that the line is real, that the bot follows it from
// wherever it is, and that an off-line board falls back rather than inventing
// a move.

test("the tier is described as PACE, because that is all it changes", () => {
  assert.equal(aiPaceLabel("easy"), "Easy pace · ~1.3s a move");
  assert.equal(aiPaceLabel("normal"), "Normal pace · ~0.9s a move");
  assert.equal(aiPaceLabel("hard"), "Hard pace · ~0.5s a move");
  // The menu's per-tier estimate and the in-race label share one rounding, so
  // the number a player picks never disagrees with the one they are shown.
  for (const tier of ["easy", "normal", "hard"]) {
    assert.equal(aiPaceLabel(tier).includes(`~${aiPaceSeconds(tier)}s a move`), true);
    assert.equal(aiPaceSeconds(tier), (AI_MOVE_DELAY_MS[tier] / 1000).toFixed(1) === "0.8" ? "0.9" : aiPaceSeconds(tier));
  }
  assert.equal(aiPaceSeconds("normal"), "0.9");
  assert.equal(aiPaceSeconds("nonsense"), aiPaceSeconds("normal"));
  // An unknown tier falls back to the shared default rather than going blank.
  assert.equal(aiPaceLabel("nonsense"), aiPaceLabel("normal"));
  // The copy never claims strength, only speed: easy is not "weaker".
  for (const tier of ["easy", "normal", "hard"]) {
    assert.match(aiPaceLabel(tier), /pace/);
    assert.doesNotMatch(aiPaceLabel(tier), /skill|weaker|smarter|easier/i);
  }
});

test("the verified line really solves the deal it came from", () => {
  for (const seed of [7, 2026]) {
    const deal = solvableDealFromSeed(seed);
    const line = solveDealLine(deal);
    assert.ok(line, `seed ${seed}: a proven deal must yield a line`);
    assert.ok(line.length > 0);

    let state = initialStateFromDeal(deal);
    for (const move of line) {
      const applied = applyMove({ state, move });
      assert.equal(applied.ok, true, `seed ${seed}: ${JSON.stringify(move)} must apply`);
      state = applied.state;
    }
    assert.equal(state.completed, true, `seed ${seed}: the line must finish the board`);
  }
});

test("the bot follows the line and finishes, on every tier", () => {
  const deal = solvableDealFromSeed(2026);
  const line = solveDealLine(deal);
  assert.ok(line);

  for (const difficulty of ["easy", "normal", "hard"]) {
    const plan = planAiSolution({
      state: initialStateFromDeal(deal),
      line,
      maxMoves: line.length + 10,
    });
    assert.ok(plan, `${difficulty}: the line must be followable`);
    assert.equal(plan.completed, true, `${difficulty} must finish the puzzle`);
    assert.equal(plan.stuck, false, "a line that finishes is never stuck");
    assert.deepEqual(plan.moves, line, "the bot plays exactly the proven moves");
    // Difficulty is PACE: every tier plays the same winning line.
    assert.ok(AI_MOVE_DELAY_MS[difficulty] > 0);
  }
});

test("the bot resumes the line from its own ply", () => {
  const deal = solvableDealFromSeed(4242);
  const line = solveDealLine(deal);
  assert.ok(line);
  const opening = initialStateFromDeal(deal);

  const first = planAiSolution({ state: opening, line, maxMoves: 5 });
  assert.ok(first);
  assert.deepEqual(first.moves, line.slice(0, 5));
  assert.equal(first.state.ply, opening.ply + 5);

  const rest = planAiSolution({ state: first.state, line, maxMoves: line.length });
  assert.ok(rest);
  assert.equal(rest.completed, true, "a resumed bot still finishes");
  assert.deepEqual([...first.moves, ...rest.moves], line);
});

test("a board that is off the line falls back rather than inventing a move", () => {
  const deal = solvableDealFromSeed(31337);
  const line = solveDealLine(deal);
  assert.ok(line);
  const opening = initialStateFromDeal(deal);

  // A move the engine refuses must end the attempt, not produce a plan.
  const bogus = planAiSolution({ state: opening, line: [{ kind: "nonsense" }], maxMoves: 5 });
  assert.equal(bogus, null, "a refused line move must not become a plan");

  // No line at all, or a cursor past its end: the caller uses the heuristic.
  assert.equal(planAiSolution({ state: opening, line: null, maxMoves: 5 }), null);
  assert.equal(planAiSolution({ state: opening, line: [], maxMoves: 5 }), null);
  const advanced = planAiSolution({ state: opening, line, maxMoves: 10 });
  assert.ok(advanced);
  assert.equal(
    planAiSolution({ state: advanced.state, line: line.slice(0, 3), maxMoves: 5 }),
    null,
    "a line shorter than the bot's ply is not followable",
  );
});
