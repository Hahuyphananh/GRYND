// tests/solitaire-analysis.test.mjs
//
// THE GAME REVIEW ENGINE (src/lib/solitaire-duel/analysis.ts).
//
// Everything here drives the REAL engine: deals are plain `SolitaireDeal`
// objects, move logs are `{kind, move}` entries that `applyMove` accepts, and
// the analyser is fed exactly what a store row would hold. No rule is mocked.
//
// Two properties are tested structurally rather than by inspection:
//
//   * INFORMATION FAIRNESS — the same log is analysed against deals whose
//     face-down identities and stock order differ. The analysis must be
//     identical, including any negative rating.
//   * DETERMINISM — the same input analysed twice is deep-equal.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ANALYSIS_VERSION,
  analyzeSolitaireGame,
  evaluateSolitairePosition,
} from "../src/lib/solitaire-duel/analysis.ts";
import { applyMove, initialStateFromDeal } from "../src/lib/solitaire-duel/rules.ts";
import { chooseAiMove } from "../src/lib/solitaire-duel/ai.ts";
import { solvableDealFromSeed } from "../src/lib/solitaire-duel/solvable.ts";
import { TUTORIAL_DEAL } from "../src/lib/solitaire-duel/tutorial.ts";

// ── Fixture helpers ───────────────────────────────────────────────────────

const C = (suit, rank) => ({ suit, rank });
const P = (card, faceUp = true) => ({ card, faceUp });

/** A deal with exactly seven columns; omitted columns are empty. */
function dealOf(columns, stock = []) {
  return {
    variant: "klondike-1",
    variantVersion: 3,
    tableau: Array.from({ length: 7 }, (_, index) => columns[index] ?? []),
    stock,
  };
}

/** A log in the shape `solitaire_duel_moves` stores: `{kind, move}`. */
const logOf = (...moves) => moves.map((move) => ({ kind: move.kind, move }));

const analyze = (deal, moves, options) => analyzeSolitaireGame({ deal, moves, options });

/** Seven non-empty filler columns so no empty column exists. */
const FILLER = [
  undefined,
  undefined,
  undefined,
  [P(C("clubs", 3))],
  [P(C("clubs", 4))],
  [P(C("clubs", 5))],
  [P(C("clubs", 6))],
];

/** Play a deterministic, legal game with a fast bot, for long-log fixtures. */
function botLog(deal, limit = 120) {
  let state = initialStateFromDeal(deal);
  const entries = [];
  while (entries.length < limit && !state.completed) {
    const move = chooseAiMove({ state, botId: "rookie", random: () => 0.99 });
    if (!move) break;
    const applied = applyMove({ state, move });
    if (!applied.ok) break;
    entries.push({ kind: move.kind, move });
    state = applied.state;
  }
  return entries;
}

// ── Shape and determinism ─────────────────────────────────────────────────

test("the analysis carries its version and one result per accepted move", () => {
  const deal = dealOf([[P(C("spades", 5))]], [C("hearts", 5)]);
  const result = analyze(deal, logOf({ kind: "draw" }));

  assert.equal(result.version, ANALYSIS_VERSION);
  assert.ok(Number.isInteger(ANALYSIS_VERSION) && ANALYSIS_VERSION >= 1);
  assert.equal(result.reconstructable, true);
  assert.equal(result.complete, false);
  assert.equal(result.rejectedAt, null);
  assert.equal(result.perMove.length, 1);
  assert.equal(result.summary.movesAnalyzed, 1);
  assert.equal(result.summary.informationFair, true);
});

test("the same deal and log always produce byte-identical analysis", () => {
  const deal = dealOf(
    [[P(C("spades", 5)), P(C("hearts", 4))], [P(C("clubs", 5))], [P(C("spades", 1))]],
    [C("hearts", 5)]
  );
  const moves = logOf(
    { kind: "tableau-to-tableau", fromColumn: 0, card: C("hearts", 4), toColumn: 1 },
    { kind: "draw" }
  );

  assert.deepEqual(analyze(deal, moves), analyze(deal, moves));
});

// ── Routine play ──────────────────────────────────────────────────────────

test("routine card movement defaults to normal", () => {
  const deal = dealOf([[P(C("spades", 5)), P(C("hearts", 4))], [P(C("clubs", 5))]]);
  const result = analyze(
    deal,
    logOf({ kind: "tableau-to-tableau", fromColumn: 0, card: C("hearts", 4), toColumn: 1 })
  );
  const move = result.perMove[0];

  assert.equal(move.rating, "normal");
  assert.equal(move.delta, 0);
  assert.ok(move.tags.includes("pointless-shuffle"));
  assert.ok(move.reasonCodes.includes("only-legal-move"));
  assert.equal(move.commentaryEligible, false);
});

test("a stock draw is never rated good or bad", () => {
  const deal = dealOf([[P(C("spades", 5))]], [C("hearts", 5)]);
  const move = analyze(deal, logOf({ kind: "draw" })).perMove[0];

  assert.equal(move.rating, "normal");
  assert.equal(move.delta, 0);
  assert.equal(move.regret, 0);
  assert.ok(move.tags.includes("stock-draw"));
});

test("a waste redeal is distinguished from a stock draw", () => {
  // The tutorial stock holds 47 cards; the 48th draw recycles the waste.
  const draws = Array.from({ length: 48 }, () => ({ kind: "draw" }));
  const result = analyze(TUTORIAL_DEAL, logOf(...draws));

  const first = result.perMove[0];
  const last = result.perMove[result.perMove.length - 1];

  assert.ok(first.tags.includes("stock-draw"));
  assert.equal(first.rating, "normal");
  assert.ok(last.tags.includes("waste-redeal"));
  assert.ok(last.tags.includes("wasted-redeal"), "a productive move was on the table");
  assert.equal(last.rating, "inaccuracy");
  assert.equal(result.perMove.length, 48);
});

// ── Positive structure ────────────────────────────────────────────────────

test("revealing a hidden card is a meaningful gain", () => {
  const deal = dealOf(
    [[P(C("spades", 6), false), P(C("diamonds", 7))], [P(C("clubs", 8))]],
    [C("hearts", 5)]
  );
  const move = analyze(
    deal,
    logOf({
      kind: "tableau-to-tableau",
      fromColumn: 0,
      card: C("diamonds", 7),
      toColumn: 1,
    })
  ).perMove[0];

  assert.ok(move.tags.includes("revealed-hidden"));
  assert.ok(move.scoreAfter > move.scoreBefore);
  assert.equal(move.rating, "good");
  assert.equal(move.commentaryEligible, false);
});

test("emptying a column by making a foundation move is great", () => {
  const deal = dealOf(
    [
      [P(C("spades", 1))],
      [P(C("clubs", 3))],
      [P(C("clubs", 4))],
      [P(C("clubs", 5))],
      [P(C("clubs", 6))],
      [P(C("clubs", 7))],
      [P(C("clubs", 8))],
    ],
    [C("hearts", 5)]
  );
  const move = analyze(
    deal,
    logOf({
      kind: "tableau-to-foundation",
      fromColumn: 0,
      card: C("spades", 1),
      suit: "spades",
    })
  ).perMove[0];

  assert.ok(move.tags.includes("opened-column"));
  assert.ok(move.tags.includes("foundation-progress"));
  assert.equal(move.rating, "great");
  assert.equal(move.commentaryEligible, true);
});

test("opening a column that unlocks a King run is brilliant", () => {
  const deal = dealOf(
    [
      [P(C("spades", 1))],
      [P(C("hearts", 13)), P(C("spades", 12))],
      [P(C("clubs", 3))],
      [P(C("clubs", 4))],
      [P(C("clubs", 5))],
      [P(C("clubs", 6))],
      [P(C("clubs", 7))],
    ],
    [C("hearts", 5)]
  );
  const result = analyze(
    deal,
    logOf({
      kind: "tableau-to-foundation",
      fromColumn: 0,
      card: C("spades", 1),
      suit: "spades",
    })
  );
  const move = result.perMove[0];

  assert.ok(move.tags.includes("opened-column"));
  assert.ok(move.tags.includes("unlocked-sequence"));
  assert.equal(move.rating, "brilliant");
  assert.equal(move.commentaryEligible, true);
  assert.equal(result.summary.ratings.brilliant, 1);
  assert.ok(result.moments.some((moment) => moment.ply === 0));
});

test("moving a King into an empty column is tagged and never over-rated", () => {
  const deal = dealOf([
    [P(C("spades", 13))],
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  const move = analyze(
    deal,
    logOf({
      kind: "tableau-to-tableau",
      fromColumn: 0,
      card: C("spades", 13),
      toColumn: 1,
    })
  ).perMove[0];

  assert.ok(move.tags.includes("king-to-empty-column"));
  assert.ok(move.tags.includes("opened-column"));
  assert.equal(move.rating, "normal");
  assert.equal(move.delta, 0);
});

// ── Negative ratings, only when a visible alternative was better ──────────

test("pulling a card back off a foundation is a mistake", () => {
  const deal = dealOf([[P(C("hearts", 1))], [P(C("spades", 2))]], [C("clubs", 5)]);
  const result = analyze(
    deal,
    logOf(
      {
        kind: "tableau-to-foundation",
        fromColumn: 0,
        card: C("hearts", 1),
        suit: "hearts",
      },
      { kind: "foundation-to-tableau", suit: "hearts", toColumn: 1 }
    )
  );
  const move = result.perMove[1];

  assert.ok(move.tags.includes("pulled-from-foundation"));
  assert.equal(move.rating, "mistake");
  assert.equal(move.commentaryEligible, true);
});

test("a pointless shuffle that ignores a foundation move is a mistake", () => {
  const deal = dealOf([
    [P(C("spades", 5)), P(C("hearts", 4))],
    [P(C("clubs", 5))],
    undefined,
    [P(C("spades", 1))],
  ]);
  const move = analyze(
    deal,
    logOf({
      kind: "tableau-to-tableau",
      fromColumn: 0,
      card: C("hearts", 4),
      toColumn: 1,
    })
  ).perMove[0];

  assert.ok(move.tags.includes("pointless-shuffle"));
  assert.equal(move.rating, "mistake");
  assert.ok(move.regret >= 600);
});

test("dumping an Ace onto the tableau instead of the foundation is a blunder", () => {
  const deal = dealOf(
    [
      [P(C("spades", 1))],
      [P(C("spades", 2))],
      [P(C("clubs", 3))],
      [P(C("clubs", 4))],
      [P(C("clubs", 5))],
      [P(C("clubs", 6))],
      [P(C("clubs", 7))],
    ],
    // The LAST stock element is drawn first.
    [C("hearts", 1)]
  );
  const result = analyze(deal, logOf({ kind: "draw" }, { kind: "waste-to-tableau", toColumn: 1 }));
  const move = result.perMove[1];

  assert.equal(result.perMove[0].tags.includes("stock-draw"), true);
  assert.equal(move.rating, "blunder");
  assert.equal(move.commentaryEligible, true);
  assert.ok(move.regret >= 1_100);
});

// ── Information fairness ──────────────────────────────────────────────────

test("hidden card identities cannot change a move score or rating", () => {
  const visible = dealOf(
    [[P(C("spades", 6), false), P(C("diamonds", 7))], [P(C("clubs", 8))]],
    [C("hearts", 5)]
  );
  const swapped = dealOf(
    [[P(C("spades", 9), false), P(C("diamonds", 7))], [P(C("clubs", 8))]],
    [C("hearts", 5)]
  );
  const moves = logOf({
    kind: "tableau-to-tableau",
    fromColumn: 0,
    card: C("diamonds", 7),
    toColumn: 1,
  });

  assert.deepEqual(analyze(visible, moves), analyze(swapped, moves));
  assert.equal(
    evaluateSolitairePosition(initialStateFromDeal(visible)),
    evaluateSolitairePosition(initialStateFromDeal(swapped))
  );
});

test("stock order cannot change the analysis", () => {
  const first = dealOf([[P(C("spades", 5))]], [C("hearts", 5), C("diamonds", 6)]);
  const second = dealOf([[P(C("spades", 5))]], [C("diamonds", 6), C("hearts", 5)]);
  const moves = logOf({ kind: "draw" }, { kind: "draw" });

  assert.deepEqual(analyze(first, moves), analyze(second, moves));
});

test("a hidden card cannot manufacture or remove a negative rating", () => {
  const baseColumns = [
    [P(C("spades", 1))],
    [P(C("spades", 2))],
    [P(C("clubs", 3))],
    [P(C("clubs", 4))],
    [P(C("clubs", 5))],
    [P(C("clubs", 6))],
    [P(C("clubs", 7))],
  ];
  const withHidden = dealOf(
    [...baseColumns.slice(0, 6), [P(C("clubs", 9), false), P(C("clubs", 7))]],
    [C("hearts", 1)]
  );
  const hiddenSwapped = dealOf(
    [...baseColumns.slice(0, 6), [P(C("diamonds", 12), false), P(C("clubs", 7))]],
    [C("hearts", 1)]
  );
  const moves = logOf({ kind: "draw" }, { kind: "waste-to-tableau", toColumn: 1 });

  const a = analyze(dealOf(baseColumns, [C("hearts", 1)]), moves);
  const b = analyze(withHidden, moves);
  const c = analyze(hiddenSwapped, moves);

  assert.equal(a.perMove[1].rating, "blunder");
  assert.deepEqual(b.perMove[1], c.perMove[1]);
  assert.equal(b.perMove[1].rating, "blunder");
});

// ── Robustness ───────────────────────────────────────────────────────────

test("an illegal or mismatched log stops cleanly and reports where", () => {
  const deal = dealOf([[P(C("spades", 5))]], [C("hearts", 5)]);

  const illegal = analyze(
    deal,
    logOf({ kind: "tableau-to-tableau", fromColumn: 0, card: C("spades", 5), toColumn: 1 })
  );
  assert.equal(illegal.reconstructable, false);
  assert.equal(illegal.rejectedAt, 0);
  assert.equal(illegal.perMove.length, 0);
  assert.equal(illegal.complete, false);

  const malformed = analyze(deal, [{ kind: "draw", move: { kind: "not-a-move" } }]);
  assert.equal(malformed.reconstructable, false);
  assert.equal(malformed.rejectedAt, 0);

  const mismatched = analyze(deal, [
    { kind: "draw", move: { kind: "draw" } },
    { kind: "waste-to-foundation", move: { kind: "draw" } },
  ]);
  assert.equal(mismatched.perMove.length, 1);
  assert.equal(mismatched.reconstructable, false);
  assert.equal(mismatched.rejectedAt, 1);
});

test("a malformed deal is refused instead of throwing", () => {
  const result = analyzeSolitaireGame({ deal: null, moves: [] });
  assert.equal(result.reconstructable, false);
  assert.equal(result.rejectedAt, 0);
  assert.deepEqual(result.perMove, []);
});

test("an undo-truncated log analyses its prefix and reports incompleteness", () => {
  const deal = solvableDealFromSeed(7);
  const full = botLog(deal, 20);
  assert.ok(full.length >= 8, "fixture needs a real prefix");

  const prefix = full.slice(0, 6);
  const truncated = analyze(deal, prefix);
  const fullResult = analyze(deal, full);

  assert.equal(truncated.reconstructable, true);
  assert.equal(truncated.complete, false);
  assert.equal(truncated.perMove.length, 6);
  assert.deepEqual(truncated.perMove, fullResult.perMove.slice(0, 6));
});

test("a long game analyses every move within the deeper-search cap", () => {
  const deal = solvableDealFromSeed(7);
  const moves = botLog(deal, 120);
  assert.ok(moves.length >= 20, "fixture needs a real game");

  const result = analyze(deal, moves, { deepSearch: true });
  const counted = Object.values(result.summary.ratings).reduce((sum, n) => sum + n, 0);

  assert.equal(result.perMove.length, moves.length);
  assert.equal(result.summary.movesAnalyzed, moves.length);
  assert.equal(counted, moves.length);
  assert.ok(result.summary.deepSearchMoves <= 16, "deeper search must stay capped");
  for (const move of result.perMove) {
    assert.ok(move.rating.length > 0);
    assert.equal(typeof move.scoreBefore, "number");
    assert.equal(typeof move.scoreAfter, "number");
    assert.equal(move.delta, move.scoreAfter - move.scoreBefore);
  }
});

test("a game with no notable decisions contains no great or brilliant moves", () => {
  const draws = Array.from({ length: 20 }, () => ({ kind: "draw" }));
  const result = analyze(TUTORIAL_DEAL, logOf(...draws));

  assert.equal(result.summary.ratings.great, 0);
  assert.equal(result.summary.ratings.brilliant, 0);
  assert.equal(result.summary.ratings.blunder, 0);
  assert.equal(result.moments.length, 0);
});
