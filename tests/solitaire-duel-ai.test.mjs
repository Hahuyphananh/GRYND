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
  aiMoveDelayMs,
  chooseAiMove,
  legalMoves,
  planAiMoves,
} from "../src/lib/solitaire-duel/ai.ts";
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
  const chosen = chooseAiMove({ state, difficulty: "hard" });
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

  const chosen = chooseAiMove({ state, difficulty: "hard" });
  assert.equal(chosen.kind, "tableau-to-tableau");
  assert.equal(chosen.fromColumn, 0);
  assert.equal(chosen.toColumn, 1);
  assert.deepEqual(chosen.card, card("hearts", 5));
});

test("easy can slip to a worse legal move, hard never does", () => {
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
  const hard = chooseAiMove({ state, difficulty: "hard", random: () => 0 });
  const easy = chooseAiMove({ state, difficulty: "easy", random: () => 0 });
  // Hard always plays the best move (the reveal); easy slips on a 0 roll.
  assert.equal(hard.kind, "tableau-to-tableau");
  assert.ok(easy, "a slip is still a move");
  assert.equal(legalMoves(state).some((move) => sameMove(move, easy)), true);
  assert.notEqual(JSON.stringify(easy), JSON.stringify(hard));
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
