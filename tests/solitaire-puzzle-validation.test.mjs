/**
 * SOLITAIRE PUZZLE VALIDATION — the engine contract behind a puzzle spec.
 *
 * These tests pin the guarantees the validation engine makes, using the REAL
 * Klondike engine to build fixtures (no hand-written boards):
 *
 *   * a solution path is replayed through `applyMove`, so an illegal move is
 *     refused at its index;
 *   * every implemented objective type is only satisfied by its actual goal —
 *     a legal move that does not reach it is `OBJECTIVE_NOT_MET`;
 *   * several accepted solutions are supported, and a claimed solution that
 *     does not reach the objective is an error rather than silently ignored;
 *   * move and stock-pass limits are measured from the replay;
 *   * an invalid starting state is refused before any path runs;
 *   * objectives, hints and public payloads cannot name a hidden card;
 *   * the spec version is checked, and an existing seeded puzzle migrates to a
 *     spec with its original id;
 *   * every collection and path is bounded, so validation can never become
 *     unbounded work.
 *
 * Run: node --import tsx --test tests/solitaire-puzzle-validation.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { dealFromSeed } from "../src/lib/solitaire-duel/deck.ts";
import {
  applyMove,
  initialStateFromDeal,
} from "../src/lib/solitaire-duel/rules.ts";
import { legalMoves } from "../src/lib/solitaire-duel/ai.ts";
import { getUnlimitedPuzzle } from "../src/lib/solitaire-duel/puzzle.ts";
import {
  PUZZLE_LIMITS,
  PUZZLE_SPEC_VERSION,
  assessPuzzleComplexity,
  isSupportedPuzzleVersion,
  objectiveReached,
  puzzlePublicSpec,
  puzzleVersionIssue,
  replayPuzzlePath,
  specFromBestMovePuzzle,
  validatePuzzle,
  validatePuzzleSolution,
  validatePuzzleSpec,
  validateStartState,
} from "../src/lib/solitaire-duel/puzzleValidation.ts";

// ── Fixtures, all derived from the real engine ────────────────────────────

function opening(seed) {
  return initialStateFromDeal(dealFromSeed(seed));
}

/** The first legal move on any opening deal that satisfies `predicate`. */
function findSetup(predicate, maxSeeds = 60) {
  for (let seed = 0; seed < maxSeeds; seed += 1) {
    const state = opening(seed);
    for (const move of legalMoves(state)) {
      const applied = applyMove({ state, move });
      if (!applied.ok) continue;
      const hit = predicate({ seed, state, move, applied });
      if (hit) return { seed, state, move, applied };
    }
  }
  return null;
}

function revealSetup() {
  const found = findSetup(({ applied }) => (applied.revealed?.length ?? 0) >= 1);
  assert.ok(found, "a deal must offer a revealing move");
  return found;
}

function foundationSetup() {
  const found = findSetup(({ move }) => move.kind === "tableau-to-foundation");
  assert.ok(found, "a deal must offer a tableau-to-foundation move");
  return found;
}

function openingSetup() {
  const found = findSetup(({ applied }) =>
    applied.state.tableau.some((column, index) => column.length === 0 && opening(0).tableau[index] !== undefined),
  );
  // The predicate above is intentionally permissive; the real assertion is that
  // some legal move leaves an empty column. Re-scan strictly if it missed.
  if (found) {
    const before = found.state.tableau.some((column) => column.length === 0);
    const after = found.applied.state.tableau.some((column) => column.length === 0);
    if (!before && after) return found;
  }
  const strict = findSetup(({ state, applied }) => {
    const beforeEmpty = state.tableau.filter((column) => column.length === 0).length;
    const afterEmpty = applied.state.tableau.filter((column) => column.length === 0).length;
    return afterEmpty > beforeEmpty;
  });
  assert.ok(strict, "a deal must offer a move that opens a column");
  return strict;
}

function visibleCardOutside(state, column) {
  for (let index = 0; index < state.tableau.length; index += 1) {
    if (index === column) continue;
    for (const pile of state.tableau[index]) {
      if (pile.faceUp && pile.card) return pile.card;
    }
  }
  return null;
}

function hiddenCardIn(state) {
  for (const column of state.tableau) {
    for (const pile of column) if (!pile.faceUp && pile.card) return pile.card;
  }
  return state.stock[0] ?? null;
}

const RANK_TEXT = ["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUIT_LETTER = { spades: "S", hearts: "H", diamonds: "D", clubs: "C" };
const SUIT_GLYPH = { spades: "\u2660", hearts: "\u2665", diamonds: "\u2666", clubs: "\u2663" };

const BASE = {
  id: "test:spec:1",
  version: PUZZLE_SPEC_VERSION,
  category: "reveal",
  difficulty: 3,
  objectiveText: "Reveal a card.",
  concept: "Expose information.",
  objective: { kind: "reveal-cards", count: 1 },
  startState: opening(1),
  constraints: { maxMoves: 4 },
  solutions: [],
  hints: [{ text: "Look for a move that uncovers something." }],
  verification: { kind: "verified-set", checkedSolutions: 1, maxMoves: 1 },
};

function spec(overrides = {}) {
  return { ...BASE, ...overrides };
}

// ── Solution paths ────────────────────────────────────────────────────────

test("a verified path replays through the engine and reports measured stats", () => {
  const { state, move, applied } = revealSetup();
  const result = validatePuzzle(
    spec({
      startState: state,
      objective: { kind: "reveal-cards", count: 1 },
      solutions: [[move]],
      verification: { kind: "verified-set", checkedSolutions: 1, maxMoves: 1 },
    }),
  );

  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.stats.length, 1);
  assert.equal(result.stats[0].moves, 1);
  assert.equal(result.stats[0].revealed, applied.revealed.length);
  assert.equal(result.stats[0].signatures.length, 1);
  assert.deepEqual(result.finalStates[0].tableau, applied.state.tableau);
});

test("an illegal move is refused at its index, and nothing is judged past it", () => {
  const { state } = foundationSetup();
  const illegal = { kind: "waste-to-tableau", toColumn: 0 };

  // The waste starts empty, so this move cannot be legal at the opening.
  const replay = replayPuzzlePath(state, [illegal], {});
  assert.equal(replay.ok, false);
  assert.equal(replay.issues[0].code, "ILLEGAL_MOVE");
  assert.equal(replay.issues[0].moveIndex, 0);
  assert.equal(replay.stats.moves, 0);
});

test("an empty or oversized path is refused before any move runs", () => {
  const { state } = foundationSetup();

  const empty = replayPuzzlePath(state, [], {});
  assert.equal(empty.ok, false);
  assert.equal(empty.issues[0].code, "OBJECTIVE_NOT_MET");

  const oversized = replayPuzzlePath(
    state,
    Array.from({ length: PUZZLE_LIMITS.maxMoves + 1 }, () => ({ kind: "draw" })),
    {},
  );
  assert.equal(oversized.ok, false);
  assert.equal(oversized.issues[0].code, "LIMIT_EXCEEDED");
});

// ── Every implemented objective type ──────────────────────────────────────

test("reveal-cards is met only by cards actually turned over", () => {
  const { state, move } = revealSetup();
  const objective = { kind: "reveal-cards", count: 1 };

  assert.equal(objectiveReached(objective, state, { revealed: 0 }), false);
  assert.equal(objectiveReached(objective, state, { revealed: 1 }), true);

  const path = validatePuzzleSolution(spec({ startState: state, objective, solutions: [[move]] }), [move]);
  assert.equal(path.ok, true);
  assert.ok(path.stats.revealed >= 1);
});

test("open-column is met by an empty column, specific or any", () => {
  const { state, applied } = openingSetup();
  const before = state.tableau.filter((column) => column.length === 0).length;
  const after = applied.state.tableau.filter((column) => column.length === 0).length;
  assert.equal(before, 0);
  assert.ok(after > 0);

  const openedColumn = applied.state.tableau.findIndex((column) => column.length === 0);
  assert.equal(
    objectiveReached({ kind: "open-column", column: openedColumn }, applied.state),
    true,
  );
  assert.equal(objectiveReached({ kind: "open-column" }, applied.state), true);
  assert.equal(objectiveReached({ kind: "open-column" }, state), false);
});

test("place-card requires the card at the named foundation", () => {
  const { state, move, applied } = foundationSetup();
  const objective = {
    kind: "place-card",
    card: move.card,
    destination: { kind: "foundation", suit: move.suit },
  };

  assert.equal(objectiveReached(objective, state), false);
  assert.equal(objectiveReached(objective, applied.state), true);

  const path = validatePuzzleSolution(spec({ startState: state, objective, solutions: [[move]] }), [move]);
  assert.equal(path.ok, true, JSON.stringify(path.issues));
});

test("place-card also verifies a card on top of a tableau column", () => {
  const found = findSetup(({ state, move }) => {
    if (move.kind !== "tableau-to-tableau") return false;
    const column = state.tableau[move.fromColumn];
    const top = column[column.length - 1];
    return Boolean(top?.faceUp && top.card && top.card.suit === move.card.suit && top.card.rank === move.card.rank);
  });
  assert.ok(found, "a deal must offer a single-card tableau move");

  const objective = {
    kind: "place-card",
    card: found.move.card,
    destination: { kind: "tableau", column: found.move.toColumn },
  };
  assert.equal(objectiveReached(objective, found.applied.state), true);

  const path = validatePuzzleSolution(
    spec({ startState: found.state, objective, solutions: [[found.move]] }),
    [found.move],
  );
  assert.equal(path.ok, true, JSON.stringify(path.issues));
});

test("foundation-milestone supports a total and a suit/rank form", () => {
  const { state, move, applied } = foundationSetup();

  assert.equal(objectiveReached({ kind: "foundation-milestone", total: 1 }, state), false);
  assert.equal(objectiveReached({ kind: "foundation-milestone", total: 1 }, applied.state), true);

  const suit = move.suit;
  assert.equal(
    objectiveReached({ kind: "foundation-milestone", suit, rank: 1 }, applied.state),
    true,
  );

  const path = validatePuzzleSolution(
    spec({ startState: state, objective: { kind: "foundation-milestone", total: 1 }, solutions: [[move]] }),
    [move],
  );
  assert.equal(path.ok, true, JSON.stringify(path.issues));
});

test("reach-state compares every specified summary field", () => {
  const { state, move, applied } = foundationSetup();
  const target = {
    foundations: {
      spades: applied.state.foundations.spades.length,
      hearts: applied.state.foundations.hearts.length,
      diamonds: applied.state.foundations.diamonds.length,
      clubs: applied.state.foundations.clubs.length,
    },
  };
  const objective = { kind: "reach-state", target };

  assert.equal(objectiveReached(objective, state), false);
  assert.equal(objectiveReached(objective, applied.state), true);
  // An unspecified field is not compared.
  assert.equal(
    objectiveReached({ kind: "reach-state", target: { ...target, faceDown: 0 } }, applied.state),
    target.foundations &&
      applied.state.tableau.every((column) => column.every((pile) => pile.faceUp)),
  );

  const path = validatePuzzleSolution(spec({ startState: state, objective, solutions: [[move]] }), [move]);
  assert.equal(path.ok, true, JSON.stringify(path.issues));
});

test("preserve-card is only usable in a composite and is checked at the end", () => {
  const { state, move, applied } = foundationSetup();
  const kept = visibleCardOutside(state, move.fromColumn);
  assert.ok(kept, "the board must have another visible card");

  const composite = {
    kind: "all",
    objectives: [
      { kind: "preserve-card", card: kept, in: "tableau" },
      { kind: "foundation-milestone", total: 1 },
    ],
  };

  assert.equal(objectiveReached(composite, state), false, "not met before the move");
  assert.equal(objectiveReached(composite, applied.state), true);

  const path = validatePuzzleSolution(spec({ startState: state, objective: composite, solutions: [[move]] }), [move]);
  assert.equal(path.ok, true, JSON.stringify(path.issues));

  // Alone, preserve-card is already true at the start and is refused.
  const alone = validatePuzzleSpec(
    spec({ startState: state, objective: { kind: "preserve-card", card: kept, in: "tableau" } }),
  );
  assert.ok(
    alone.issues.some((entry) => entry.code === "OBJECTIVE_ALREADY_MET"),
    JSON.stringify(alone.issues),
  );
});

test("best-move completes on the accepted move, not on any legal move", () => {
  const { state, move } = foundationSetup();
  const other = legalMoves(state).find(
    (candidate) =>
      !(
        candidate.kind === move.kind &&
        JSON.stringify(candidate) === JSON.stringify(move)
      ),
  );
  assert.ok(other, "the board must offer more than one move");

  const objective = { kind: "best-move", acceptedMoves: [move] };
  const wrong = validatePuzzleSolution(
    spec({ startState: state, objective, solutions: [[other]] }),
    [other],
  );
  assert.equal(wrong.ok, false);
  assert.equal(wrong.issues[0].code, "OBJECTIVE_NOT_MET");

  const right = validatePuzzleSolution(
    spec({ startState: state, objective, solutions: [[move]] }),
    [move],
  );
  assert.equal(right.ok, true, JSON.stringify(right.issues));
});

// ── Multiple accepted solutions ───────────────────────────────────────────

test("several accepted solutions are supported and all must reach the objective", () => {
  const { state } = foundationSetup();
  const moves = legalMoves(state).slice(0, 2);
  assert.equal(moves.length, 2, "the fixture needs two legal moves");

  const objective = { kind: "best-move", acceptedMoves: moves };
  const result = validatePuzzle(
    spec({
      startState: state,
      category: "best-move",
      difficulty: 2,
      objective,
      solutions: [[moves[0]], [moves[1]]],
      constraints: { maxMoves: 1 },
      verification: { kind: "verified-set", checkedSolutions: 2, maxMoves: 1 },
    }),
  );
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.stats.length, 2);
  assert.equal(result.metrics.distinctFirstMoves, 2);

  // A declared path that does not reach the objective is a false claim.
  const broken = validatePuzzle(
    spec({
      startState: state,
      objective: { kind: "best-move", acceptedMoves: [moves[0]] },
      solutions: [[moves[1]]],
      constraints: { maxMoves: 1 },
    }),
  );
  assert.equal(broken.ok, false);
  assert.ok(broken.issues.some((entry) => entry.code === "OBJECTIVE_NOT_MET"));
});

// ── Constraints ───────────────────────────────────────────────────────────

test("maxMoves is measured from the replay", () => {
  const { state } = foundationSetup();
  const first = legalMoves(state)[0];
  const after = applyMove({ state, move: first });
  assert.equal(after.ok, true);
  const second = legalMoves(after.state)[0];

  const result = validatePuzzle(
    spec({
      startState: state,
      category: "best-move",
      objective: { kind: "best-move", acceptedMoves: [second] },
      solutions: [[first, second]],
      constraints: { maxMoves: 1 },
      verification: { kind: "verified-set", checkedSolutions: 1, maxMoves: 2 },
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.code === "MOVE_LIMIT_EXCEEDED"));
});

test("maxStockPasses counts completed passes through the stock", () => {
  // 23 draws leave one stock card, so the next draw completes a pass.
  let state = opening(3);
  for (let draw = 0; draw < 23; draw += 1) {
    const applied = applyMove({ state, move: { kind: "draw" } });
    assert.equal(applied.ok, true);
    state = applied.state;
  }
  assert.equal(state.stock.length, 1);

  const objective = { kind: "best-move", acceptedMoves: [{ kind: "draw" }] };
  const denied = validatePuzzle(
    spec({
      startState: state,
      category: "best-move",
      objective,
      solutions: [[{ kind: "draw" }]],
      constraints: { maxMoves: 1, maxStockPasses: 0 },
    }),
  );
  assert.equal(denied.ok, false);
  assert.ok(denied.issues.some((entry) => entry.code === "STOCK_PASS_LIMIT_EXCEEDED"));

  const allowed = validatePuzzle(
    spec({
      startState: state,
      category: "best-move",
      objective,
      solutions: [[{ kind: "draw" }]],
      constraints: { maxMoves: 1, maxStockPasses: 1 },
    }),
  );
  assert.equal(allowed.ok, true, JSON.stringify(allowed.issues));
  assert.equal(allowed.stats[0].stockPasses, 1);
});

// ── Starting state and spec integrity ─────────────────────────────────────

test("an invalid starting state is refused before any path is replayed", () => {
  const { state, move } = foundationSetup();
  const broken = {
    ...state,
    stock: [state.stock[1], ...state.stock.slice(1)],
  };

  const issues = validateStartState(broken);
  assert.ok(issues.length > 0);
  assert.equal(issues[0].code, "INVALID_STATE");

  const result = validatePuzzle(
    spec({ startState: broken, objective: { kind: "reveal-cards", count: 1 }, solutions: [[move]] }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.code === "INVALID_STATE"));
  assert.equal(result.stats, undefined, "no path may run against an invalid board");
});

test("malformed specs are refused with author-facing errors", () => {
  const { state } = foundationSetup();

  assert.ok(
    validatePuzzleSpec(spec({ id: "", startState: state })).issues.some(
      (entry) => entry.code === "INVALID_SPEC",
    ),
  );
  assert.ok(
    validatePuzzleSpec(spec({ difficulty: 9, startState: state })).issues.some(
      (entry) => entry.code === "INVALID_SPEC",
    ),
  );
  assert.ok(
    validatePuzzleSpec(spec({ category: "telepathy", startState: state })).issues.some(
      (entry) => entry.code === "INVALID_SPEC",
    ),
  );
  assert.ok(
    validatePuzzleSpec(spec({ objective: { kind: "reveal-cards", count: 0 }, startState: state })).issues.some(
      (entry) => entry.code === "INVALID_OBJECTIVE",
    ),
  );
  assert.ok(
    validatePuzzleSpec(spec({ startState: state, solutions: [] })).issues.some(
      (entry) => entry.code === "NO_SOLUTIONS",
    ),
  );
  assert.ok(
    validatePuzzleSpec(spec({ startState: state, constraints: { maxMoves: 5000 } })).issues.some(
      (entry) => entry.code === "INVALID_SPEC",
    ),
  );
});

test("contradictory objectives are detected", () => {
  const { state } = foundationSetup();
  const result = validatePuzzleSpec(
    spec({
      startState: state,
      objective: {
        kind: "all",
        objectives: [
          { kind: "foundation-milestone", total: 5 },
          {
            kind: "reach-state",
            target: {
              foundations: { spades: 0, hearts: 0, diamonds: 0, clubs: 0 },
            },
          },
        ],
      },
    }),
  );
  assert.ok(
    result.issues.some((entry) => entry.code === "CONTRADICTORY_OBJECTIVES"),
    JSON.stringify(result.issues),
  );
});

// ── Hidden information ────────────────────────────────────────────────────

test("an objective may never name a hidden card", () => {
  const state = opening(2);
  const hidden = hiddenCardIn(state);
  assert.ok(hidden, "the opening position has hidden cards");

  const result = validatePuzzleSpec(
    spec({
      startState: state,
      objective: {
        kind: "place-card",
        card: hidden,
        destination: { kind: "foundation", suit: hidden.suit },
      },
      solutions: [[{ kind: "draw" }]],
    }),
  );
  assert.ok(
    result.issues.some((entry) => entry.code === "HIDDEN_INFO_LEAK"),
    JSON.stringify(result.issues),
  );
});

test("a hint may never name or spell a hidden card", () => {
  const state = opening(2);
  const hidden = hiddenCardIn(state);
  assert.ok(hidden);

  const structured = validatePuzzleSpec(
    spec({ startState: state, hints: [{ text: "Focus here.", card: hidden }] }),
  );
  assert.ok(structured.issues.some((entry) => entry.code === "HIDDEN_INFO_LEAK"));

  const spelled = validatePuzzleSpec(
    spec({
      startState: state,
      hints: [{ text: `The ${RANK_TEXT[hidden.rank]}${SUIT_LETTER[hidden.suit]} is coming.` }],
    }),
  );
  assert.ok(
    spelled.issues.some((entry) => entry.code === "HIDDEN_INFO_LEAK"),
    JSON.stringify(spelled.issues),
  );

  // Prose that does not name a card stays allowed.
  const prose = validatePuzzleSpec(
    spec({ startState: state, hints: [{ text: "Three cards are still face down." }] }),
  );
  assert.equal(
    prose.issues.filter((entry) => entry.code === "HIDDEN_INFO_LEAK").length,
    0,
    JSON.stringify(prose.issues),
  );
});

test("the public payload exposes only visible information", () => {
  const { state, move } = foundationSetup();
  const specValue = spec({
    startState: state,
    category: "best-move",
    objective: { kind: "best-move", acceptedMoves: [move] },
    solutions: [[move]],
    constraints: { maxMoves: 1 },
  });
  const publicSpec = puzzlePublicSpec(specValue);
  const json = JSON.stringify(publicSpec);

  assert.equal(publicSpec.board.nextStockCard, null, "the next stock card must not ship");
  assert.equal(publicSpec.board.stockCount, state.stock.length);
  assert.equal("startState" in publicSpec, false);
  assert.equal("solutions" in publicSpec, false);
  assert.equal(publicSpec.objective.kind, "best-move");
  assert.equal("acceptedMoves" in publicSpec.objective, false, "the answer must not ship");
  assert.equal(json.includes("acceptedMoves"), false);

  // No face-down position carries an identity.
  for (const column of publicSpec.board.tableau) {
    for (const pile of column) {
      if (!pile.faceUp) assert.equal(pile.card, null);
    }
  }

  // Every hidden card identity is absent from the payload.
  for (const column of state.tableau) {
    for (const pile of column) {
      if (pile.faceUp || !pile.card) continue;
      assert.equal(
        json.includes(`"suit":"${pile.card.suit}","rank":${pile.card.rank}`),
        false,
        "a face-down card identity leaked into the payload",
      );
    }
  }
});

// ── Versioning and legacy migration ───────────────────────────────────────

test("only the supported spec version is accepted", () => {
  assert.equal(isSupportedPuzzleVersion(PUZZLE_SPEC_VERSION), true);
  assert.equal(isSupportedPuzzleVersion(PUZZLE_SPEC_VERSION + 1), false);

  const { state, move } = foundationSetup();
  const result = validatePuzzle(
    spec({ version: PUZZLE_SPEC_VERSION + 1, startState: state, solutions: [[move]] }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((entry) => entry.code === "UNSUPPORTED_VERSION"));
  assert.equal(puzzleVersionIssue({ version: 99 })?.code, "UNSUPPORTED_VERSION");
  assert.equal(puzzleVersionIssue({ version: PUZZLE_SPEC_VERSION }), null);
});

test("an existing seeded puzzle migrates to a spec with its original id", () => {
  const puzzle = getUnlimitedPuzzle(34);
  assert.ok(puzzle, "seed 34 must still produce the shipped practice puzzle");

  const migrated = specFromBestMovePuzzle(puzzle);
  assert.equal(migrated.id, puzzle.key, "progress rows key on the original puzzle key");
  assert.equal(migrated.version, PUZZLE_SPEC_VERSION);
  assert.equal(migrated.objective.kind, "best-move");
  assert.equal(migrated.solutions.length, 1);
  assert.equal(migrated.constraints.maxMoves, 1);

  const result = validatePuzzle(migrated);
  assert.equal(result.ok, true, JSON.stringify(result.issues));

  const publicSpec = puzzlePublicSpec(migrated);
  assert.equal(publicSpec.id, puzzle.key);
  assert.equal(JSON.stringify(publicSpec).includes("acceptedMoves"), false);
  assert.equal(publicSpec.board.nextStockCard, null);
});

// ── Determinism, bounds and cost ──────────────────────────────────────────

test("validation is deterministic for the same spec", () => {
  const { state, move } = revealSetup();
  const value = spec({
    startState: state,
    objective: { kind: "reveal-cards", count: 1 },
    solutions: [[move]],
  });

  const first = validatePuzzle(value);
  const second = validatePuzzle(value);

  assert.deepEqual(first.issues, second.issues);
  assert.deepEqual(first.stats, second.stats);
  assert.deepEqual(first.metrics, second.metrics);
});

test("collection limits and validation cost stay bounded", () => {
  const { state, move } = foundationSetup();

  const tooManySolutions = validatePuzzle(
    spec({
      startState: state,
      solutions: Array.from({ length: PUZZLE_LIMITS.maxSolutions + 1 }, () => [move]),
    }),
  );
  assert.equal(tooManySolutions.ok, false);
  assert.ok(tooManySolutions.issues.some((entry) => entry.code === "LIMIT_EXCEEDED"));

  const tooManyHints = validatePuzzleSpec(
    spec({
      startState: state,
      hints: Array.from({ length: PUZZLE_LIMITS.maxHints + 1 }, () => ({ text: "Look." })),
    }),
  );
  assert.ok(tooManyHints.issues.some((entry) => entry.code === "LIMIT_EXCEEDED"));

  const oversizedPath = validatePuzzle(
    spec({
      startState: state,
      solutions: [Array.from({ length: PUZZLE_LIMITS.maxMoves + 1 }, () => ({ kind: "draw" }))],
    }),
  );
  assert.equal(oversizedPath.ok, false);
  assert.ok(oversizedPath.issues.some((entry) => entry.code === "LIMIT_EXCEEDED"));

  // Eight real paths validate well inside a request-time budget.
  const started = Date.now();
  const eight = validatePuzzle(
    spec({
      startState: state,
      objective: { kind: "foundation-milestone", total: 1 },
      solutions: Array.from({ length: PUZZLE_LIMITS.maxSolutions }, () => [move]),
      constraints: { maxMoves: 1 },
    }),
  );
  assert.equal(eight.ok, true, JSON.stringify(eight.issues));
  assert.ok(Date.now() - started < 1000, "validation must not become search work");
});

test("complexity metrics are measured, not asserted", () => {
  const { state, move } = foundationSetup();
  const metrics = assessPuzzleComplexity(
    spec({
      startState: state,
      objective: { kind: "foundation-milestone", total: 1 },
      solutions: [[move]],
      constraints: { maxMoves: 1 },
    }),
  );

  assert.ok(metrics.branching >= 1);
  assert.ok(metrics.productiveMoves >= 1);
  assert.equal(metrics.movesToGoal, 1);
  assert.equal(metrics.stockPassesToGoal, 0);
  assert.ok(metrics.hiddenCards > 0);
  assert.ok(metrics.score >= 0 && metrics.score <= 100);
  assert.ok(metrics.suggestedDifficulty >= 1 && metrics.suggestedDifficulty <= 5);
});
