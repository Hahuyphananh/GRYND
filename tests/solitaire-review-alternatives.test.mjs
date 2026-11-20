// tests/solitaire-review-alternatives.test.mjs
//
// PHASE 1 — ALTERNATIVE-MOVE RECOMMENDATIONS.
//
// Everything here drives the real engine: real deals, `legalMoves`, `applyMove`
// and the real analyser. Nothing is mocked, and no expected move is written by
// hand where the engine can produce it.
//
// The properties under test:
//   * a recommendation is legal in the exact pre-move position;
//   * it is never the move that was played;
//   * a controlled position with a materially better move is recognised;
//   * it is linked to the reviewed ply and its visible pre-move board;
//   * hidden identities and stock order cannot change it;
//   * uncertain/routine moves produce no recommendation;
//   * the analysis's search caps still govern the lookahead;
//   * the stored log is not mutated.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  analyzeSolitaireGame,
} from "../src/lib/solitaire-duel/analysis.ts";
import {
  buildMoveRecommendation,
  sameSolitaireMove,
  visibleBoardSnapshot,
} from "../src/lib/solitaire-duel/alternatives.ts";
import { compactAnalysis } from "../src/lib/solitaire-duel/analysisCache.ts";
import { applyMove, initialStateFromDeal, replayMoves } from "../src/lib/solitaire-duel/rules.ts";
import { chooseAiMove } from "../src/lib/solitaire-duel/ai.ts";
import { solvableDealFromSeed } from "../src/lib/solitaire-duel/solvable.ts";

const C = (suit, rank) => ({ suit, rank });
const P = (card, faceUp = true) => ({ card, faceUp });

function dealOf(columns, stock = []) {
  return {
    variant: "klondike-1",
    variantVersion: 3,
    tableau: Array.from({ length: 7 }, (_, index) => columns[index] ?? []),
    stock,
  };
}

const logOf = (...moves) => moves.map((move) => ({ kind: move.kind, move }));
const analyze = (deal, moves, options) => analyzeSolitaireGame({ deal, moves, options });

/**
 * A controlled position with one materially better move:
 *
 *   - the waste top is the Ace of hearts;
 *   - the player dumps it onto the black 2 of spades (legal, but no progress);
 *   - the foundations offer that same Ace a home.
 *
 * The visible evaluator scores the foundation move 1,000 points higher.
 */
function aceDumpFixture() {
  const deal = dealOf(
    [
      [P(C("spades", 5))],
      [P(C("spades", 2))],
      [P(C("clubs", 3))],
      [P(C("clubs", 4))],
      [P(C("clubs", 5))],
      [P(C("clubs", 6))],
      [P(C("clubs", 7))],
    ],
    [C("hearts", 1)],
  );
  const moves = logOf(
    { kind: "draw" },
    { kind: "waste-to-tableau", toColumn: 1 },
  );
  return { deal, moves, result: analyze(deal, moves) };
}

function botLog(deal, limit = 80) {
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

// ── Legality and association ──────────────────────────────────────────────

test("a recommended move is legal in the exact pre-move position", () => {
  const { deal, moves, result } = aceDumpFixture();
  const recommendation = result.perMove[1].recommendation;

  assert.ok(recommendation, "the controlled mistake must carry a recommendation");

  const before = replayMoves({ deal, moves: moves.slice(0, recommendation.ply) });
  assert.equal(before.ok, true);
  assert.equal(before.state.ply, recommendation.ply);

  assert.equal(
    applyMove({ state: before.state, move: recommendation.move }).ok,
    true,
    "the suggested move must be accepted by the authoritative engine",
  );
  assert.equal(
    applyMove({ state: before.state, move: recommendation.played }).ok,
    true,
    "the played move must also be legal from that position",
  );
});

test("the recommendation is never the move that was played", () => {
  const { result } = aceDumpFixture();
  const recommendation = result.perMove[1].recommendation;

  assert.equal(sameSolitaireMove(recommendation.move, recommendation.played), false);
  assert.equal(recommendation.played.kind, "waste-to-tableau");
  assert.equal(recommendation.move.kind, "waste-to-foundation");
  assert.equal(recommendation.move.suit, "hearts");
});

test("a materially better alternative is identified in a controlled position", () => {
  const { result } = aceDumpFixture();
  const move = result.perMove[1];
  const recommendation = move.recommendation;

  assert.equal(move.rating, "inaccuracy");
  assert.ok(recommendation);
  assert.ok(
    recommendation.evidence.alternativeScore > recommendation.evidence.playedScore,
    "the alternative must score strictly higher",
  );
  assert.equal(recommendation.evidence.regret, 1_000);
  assert.equal(recommendation.evidence.foundationGain, 1);
  assert.equal(recommendation.evidence.provenOptimal, false);
  assert.equal(recommendation.basis, "best-legal-move-found-by-visible-evaluator");
  assert.deepEqual(recommendation.why, [
    "advances-foundation",
    "higher-visible-score",
  ]);
  assert.match(recommendation.explanation, /visible-position value/);
  assert.match(recommendation.explanation, /not a proven optimal move/);
  assert.ok(["high", "medium"].includes(recommendation.confidence));
});

test("the recommendation is linked to the reviewed ply and its pre-move board", () => {
  const { deal, moves, result } = aceDumpFixture();
  const recommendation = result.perMove[1].recommendation;
  const before = replayMoves({ deal, moves: moves.slice(0, 1) });

  assert.equal(recommendation.ply, 1);
  assert.equal(recommendation.before.ply, 1);
  assert.equal(recommendation.before.stockCount, before.state.stock.length);
  assert.deepEqual(recommendation.before, visibleBoardSnapshot(before.state));
  assert.equal(recommendation.played.kind, moves[1].move.kind);
  assert.equal(recommendation.played.toColumn, moves[1].move.toColumn);
});

// ── Hidden information ────────────────────────────────────────────────────

test("hidden identities cannot change a recommendation", () => {
  const columns = (hidden) => [
    [P(C("spades", 1))],
    [P(C("spades", 2))],
    [P(C("clubs", 3))],
    [P(C("clubs", 4))],
    [P(C("clubs", 5))],
    [P(C("clubs", 6))],
    [P(hidden, false)],
  ];
  const first = dealOf(columns(C("clubs", 12)), [C("hearts", 1)]);
  const second = dealOf(columns(C("diamonds", 4)), [C("hearts", 1)]);
  const moves = logOf({ kind: "draw" }, { kind: "waste-to-tableau", toColumn: 1 });

  const a = analyze(first, moves);
  const b = analyze(second, moves);

  assert.ok(a.perMove[1].recommendation);
  assert.deepEqual(a.perMove[1].recommendation, b.perMove[1].recommendation);

  // The hidden card was the King of clubs; nothing user-facing may name it.
  const payload = JSON.stringify(a.perMove[1].recommendation);
  assert.ok(!payload.includes('"rank":12'), "a hidden rank leaked into the recommendation");
  assert.ok(!/nextStockCard/.test(payload), "the next stock card leaked into the recommendation");
});

test("the recommendation payload contains no stock order or hidden card field", () => {
  const { result } = aceDumpFixture();
  const recommendation = result.perMove[1].recommendation;
  assert.ok(recommendation);
  const payload = JSON.stringify(recommendation);

  // The stock may travel only as a count; no order, no next card.
  assert.ok(!/"stock"\s*:/.test(payload), "no stock contents may travel in a recommendation");
  assert.ok(!/nextStockCard/.test(payload), "the next stock card may not travel");
  for (const pile of recommendation.before.tableau.flat()) {
    if (!pile.faceUp) assert.equal(pile.card, null);
  }
});

// ── Uncertainty and routine play ──────────────────────────────────────────

test("a lookahead that prefers the played move suppresses the recommendation", () => {
  const { deal } = aceDumpFixture();
  const drawn = applyMove({ state: initialStateFromDeal(deal), move: { kind: "draw" } });
  assert.equal(drawn.ok, true);

  const base = {
    ply: 1,
    rating: "inaccuracy",
    played: { kind: "waste-to-tableau", toColumn: 1 },
    alternative: { kind: "waste-to-foundation", suit: "hearts" },
    playedScore: 0,
    alternativeScore: 1_000,
    leadOverNextBest: 0,
    state: drawn.state,
  };

  assert.ok(buildMoveRecommendation(base), "the one-ply evidence alone is enough");
  assert.equal(
    buildMoveRecommendation({ ...base, lookaheadUsed: true, lookaheadPlayedBest: true }),
    null,
  );
});

test("an immaterial gap or the played move itself never becomes advice", () => {
  const { deal } = aceDumpFixture();
  const drawn = applyMove({ state: initialStateFromDeal(deal), move: { kind: "draw" } });
  const base = {
    ply: 1,
    rating: "inaccuracy",
    played: { kind: "waste-to-tableau", toColumn: 1 },
    alternative: { kind: "waste-to-foundation", suit: "hearts" },
    playedScore: 0,
    alternativeScore: 1_000,
    leadOverNextBest: 0,
    state: drawn.state,
  };

  assert.equal(buildMoveRecommendation({ ...base, alternativeScore: 200 }), null);
  assert.equal(
    buildMoveRecommendation({ ...base, alternative: base.played, alternativeScore: 1_000 }),
    null,
  );
});

test("routine and positive moves carry no recommendation", () => {
  const routine = analyze(
    dealOf([
      [P(C("spades", 5)), P(C("hearts", 4))],
      [P(C("clubs", 5))],
    ]),
    logOf({
      kind: "tableau-to-tableau",
      fromColumn: 0,
      card: C("hearts", 4),
      toColumn: 1,
    }),
  );
  assert.equal(routine.perMove[0].rating, "normal");
  assert.equal(routine.perMove[0].recommendation, null);

  const reveal = analyze(
    dealOf(
      [
        [P(C("spades", 6), false), P(C("diamonds", 7))],
        [P(C("clubs", 8))],
      ],
      [C("hearts", 5)],
    ),
    logOf({
      kind: "tableau-to-tableau",
      fromColumn: 0,
      card: C("diamonds", 7),
      toColumn: 1,
    }),
  );
  assert.equal(reveal.perMove[0].rating, "good");
  assert.equal(reveal.perMove[0].recommendation, null);
});

test("a real game only recommends alternatives for mistakes and inaccuracies", () => {
  const deal = solvableDealFromSeed(7);
  const moves = botLog(deal, 80);
  assert.ok(moves.length >= 10, "fixture needs a real game");

  const result = analyze(deal, moves);
  for (const move of result.perMove) {
    if (move.recommendation) {
      assert.ok(
        move.rating === "mistake" || move.rating === "inaccuracy",
        `a ${move.rating} move must not carry a recommendation`,
      );
    }
  }
  assert.equal(result.summary.ratings.blunder, 0);
});

// ── Search limits and purity ──────────────────────────────────────────────

test("the lookahead caps still govern whether a recommendation is confirmed", () => {
  const { deal, moves } = aceDumpFixture();

  const withoutLookahead = analyze(deal, moves, { deepSearch: false });
  assert.equal(withoutLookahead.summary.deepSearchMoves, 0);
  assert.ok(withoutLookahead.perMove[1].recommendation);
  assert.equal(
    withoutLookahead.perMove[1].recommendation.evidence.confirmedByLookahead,
    false,
  );

  const noDeepMoves = analyze(deal, moves, { deepMaxMoves: 0 });
  assert.equal(noDeepMoves.summary.deepSearchMoves, 0);
  assert.ok(noDeepMoves.perMove[1].recommendation);
});

test("the compact cache payload preserves the recommendation exactly", () => {
  const { result } = aceDumpFixture();
  const compact = compactAnalysis(result);

  assert.deepEqual(compact.perMove[1].recommendation, result.perMove[1].recommendation);
});

test("analysis does not mutate the stored move log", () => {
  const { deal, moves } = aceDumpFixture();
  const before = structuredClone(moves);

  analyze(deal, moves);
  assert.deepEqual(moves, before);
});

test("the alternatives module is pure commentary with no hidden-board access", () => {
  const source = fs.readFileSync("src/lib/solitaire-duel/alternatives.ts", "utf8");

  assert.doesNotMatch(source, /state\.stock/);
  assert.doesNotMatch(source, /\.nextStockCard/);
  assert.doesNotMatch(source, /from\s+["'][^"']*(?:serverStore|db\/schema|troph|practiceProgress)/i);
  assert.doesNotMatch(source, /fetch\(|insert\(|update\(|delete\(/i);
});
