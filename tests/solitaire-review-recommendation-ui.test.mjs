// tests/solitaire-review-recommendation-ui.test.mjs
//
// PHASE 2 — the better-move panel and its read-only demonstration.
//
// The repository has no jsdom harness, so this suite combines:
//   * pure behaviour of the review-side demo builder (real engine, real deal);
//   * source contracts for the page's wiring (pause, return, navigation,
//     read-only board, no result/progression calls);
//   * the three localization bundles.
//
// Run: node --import tsx --test tests/solitaire-review-recommendation-ui.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { analyzeSolitaireGame } from "../src/lib/solitaire-duel/analysis.ts";
import {
  buildRecommendationDemo,
  recommendationForMove,
} from "../src/lib/solitaire-duel/reviewRecommendation.ts";
import { applyMove, replayMoves, viewForState } from "../src/lib/solitaire-duel/rules.ts";
import { SOLITAIRE_REVIEW_TRANSLATIONS } from "../src/lib/solitaireReviewTranslations.js";

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

/**
 * A reviewed game with one genuine Inaccuracy:
 *   move 1 draws the Ace of hearts;
 *   move 2 dumps it onto the black 2 instead of its foundation.
 * Phase 1 recommends `waste-to-foundation` (hearts), +1,000 visible value.
 */
function fixture() {
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
  return { deal, moves, analysis: analyzeSolitaireGame({ deal, moves }) };
}

const PAGE = "src/app/solitaire/review/[kind]/[gameId]/PageClient.tsx";
const read = (path) => fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const code = (path) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

// ── Pure: the exact Phase 1 move, and its two positions ───────────────────

test("the review reads only the recommendation attached to that exact ply", () => {
  const { analysis } = fixture();
  const recommendation = recommendationForMove(analysis, 1);

  assert.ok(recommendation);
  assert.equal(recommendation.ply, 1);
  assert.equal(recommendation.rating, "inaccuracy");
  assert.equal(recommendation.move.kind, "waste-to-foundation");
  assert.equal(recommendation.move.suit, "hearts");
  assert.equal(recommendationForMove(analysis, 0), null, "a routine draw has none");
  assert.equal(recommendationForMove(analysis, -1), null);
  assert.equal(recommendationForMove(analysis, 99), null);
  assert.equal(recommendationForMove(null, 1), null);
});

test("good and normal moves never expose a recommendation", () => {
  const normal = analyzeSolitaireGame({
    deal: dealOf([
      [P(C("spades", 5)), P(C("hearts", 4))],
      [P(C("clubs", 5))],
    ]),
    moves: logOf({
      kind: "tableau-to-tableau",
      fromColumn: 0,
      card: C("hearts", 4),
      toColumn: 1,
    }),
  });
  assert.equal(recommendationForMove(normal, 0), null);

  const good = analyzeSolitaireGame({
    deal: dealOf(
      [
        [P(C("spades", 6), false), P(C("diamonds", 7))],
        [P(C("clubs", 8))],
      ],
      [C("hearts", 5)],
    ),
    moves: logOf({
      kind: "tableau-to-tableau",
      fromColumn: 0,
      card: C("diamonds", 7),
      toColumn: 1,
    }),
  });
  assert.equal(good.perMove[0].rating, "good");
  assert.equal(recommendationForMove(good, 0), null);
});

test("the demonstration uses exactly the recommended move and the pre-move board", () => {
  const { deal, moves, analysis } = fixture();
  const recommendation = recommendationForMove(analysis, 1);
  const demo = buildRecommendationDemo(deal, moves, recommendation);

  assert.equal(demo.ok, true);
  assert.deepEqual(demo.move, recommendation.move);
  assert.equal(demo.before.ply, 1, "the position immediately before the reviewed move");
  assert.equal(demo.after.ply, 2, "exactly one recommended move later");

  // The pre-move board is the real replay prefix, projected for a player.
  const prefix = replayMoves({ deal, moves: moves.slice(0, 1) });
  assert.deepEqual(demo.before.view, viewForState(prefix.state));

  // The after position is the engine's own answer, not a hand-built board.
  const applied = applyMove({ state: prefix.state, move: recommendation.move });
  assert.equal(applied.ok, true);
  assert.deepEqual(demo.after.view, viewForState(applied.state));
  assert.equal(demo.after.view.foundations.hearts.length, 1);

  // No hidden identity or stock order may cross the projection.
  assert.equal("stock" in demo.before.view, false);
  assert.equal("stock" in demo.after.view, false);
  for (const view of [demo.before.view, demo.after.view]) {
    for (const column of view.tableau) {
      for (const slot of column) {
        if (!slot.faceUp) assert.equal(slot.card, null);
      }
    }
  }
});

test("building a demonstration never mutates the stored log or deal", () => {
  const { deal, moves, analysis } = fixture();
  const movesBefore = structuredClone(moves);
  const dealBefore = structuredClone(deal);

  buildRecommendationDemo(deal, moves, recommendationForMove(analysis, 1));

  assert.deepEqual(moves, movesBefore);
  assert.deepEqual(deal, dealBefore);
});

test("an impossible demonstration is refused instead of drawn", () => {
  const { deal, moves, analysis } = fixture();
  const recommendation = recommendationForMove(analysis, 1);

  assert.deepEqual(buildRecommendationDemo(deal, moves, { ...recommendation, ply: 99 }), {
    ok: false,
    reason: "not-reconstructable",
  });
  assert.deepEqual(
    buildRecommendationDemo(deal, moves, {
      ...recommendation,
      move: { kind: "waste-to-foundation", suit: "clubs" },
    }),
    { ok: false, reason: "not-legal" },
  );
  assert.deepEqual(buildRecommendationDemo(deal, moves, null), {
    ok: false,
    reason: "not-reconstructable",
  });
});

// ── Page contract ─────────────────────────────────────────────────────────

test("the page renders the panel only from a Phase 1 recommendation", () => {
  const source = code(PAGE);

  assert.match(source, /recommendationForMove\(analysis, selectedPly - 1\)/);
  assert.match(source, /\{recommendation && \(/);
  assert.match(source, /data-testid="review-recommendation"/);
  assert.match(source, /data-rating=\{recommendation\.rating\}/);
  assert.match(source, /data-confidence=\{recommendation\.confidence\}/);
  assert.match(source, /localizedMove\(t, recommendation\.move\)/);
  // No panel for an unsupported move: the gate is the recommendation itself.
  assert.doesNotMatch(source, /review-recommendation[^\n]*totalMoves/);
});

test("opening a recommendation pauses playback and demonstrates via the shared board", () => {
  const source = code(PAGE);

  const open = source.slice(
    source.indexOf("const openRecommendation"),
    source.indexOf("const boardView"),
  );
  assert.match(open, /setPlaying\(false\)/);
  assert.match(open, /setDemo\(\{ recommendation, phase: "before" \}\)/);
  assert.match(open, /phase: "after"/);

  assert.match(source, /buildRecommendationDemo\(data\.deal, data\.moves, demo\.recommendation\)/);
  assert.match(source, /reviewAnimate=\{boardAnimate\}/);
  assert.match(source, /data-demo=\{demo \? demo\.phase : "false"\}/);
  // The demonstration is read-only: the shared board is never interactive here.
  assert.match(source, /interactive=\{false\}/);
  assert.match(source, /readOnly/);
});

test("returning and navigating always leave the demonstration first", () => {
  const source = code(PAGE);

  const close = source.slice(
    source.indexOf("const closeRecommendation"),
    source.indexOf("const openRecommendation"),
  );
  assert.match(close, /setDemo\(null\)/);
  assert.doesNotMatch(close, /setSelectedPly/, "closing must not move the timeline");

  for (const name of ["goManually", "selectManually", "restartReview", "togglePlay"]) {
    const block = source.slice(
      source.indexOf(`const ${name}`),
      source.indexOf(`const ${name}`) + 700,
    );
    assert.match(block, /closeRecommendation\(\)/, `${name} must close the demo`);
  }
  assert.match(source, /event\.key === "Escape" && demo/);
});

test("the demonstration cannot write a result, trophy, rating or progression", () => {
  const source = code(PAGE);
  const demo = source.slice(
    source.indexOf("Phase 2: better-move recommendation"),
    source.indexOf("One move per step."),
  );

  assert.doesNotMatch(demo, /fetch\(|\.post\(|insert\(|update\(/i);
  assert.doesNotMatch(demo, /troph|leaderboard|elo|progression|rating\b/i);
  // The page's only request remains the review GET.
  assert.doesNotMatch(source, /method:\s*["']POST["']/);
});

test("every recommendation string exists in English, French and Spanish", () => {
  const keys = [
    "title",
    "instead",
    "show",
    "hide",
    "basis",
    "demoTitle",
    "demoBadge",
    "demoNote",
    "demoBack",
    "confidence.high",
    "confidence.medium",
    "reasons.foundationOne",
    "reasons.foundationMany",
    "reasons.revealOne",
    "reasons.revealMany",
    "reasons.emptyOne",
    "reasons.emptyMany",
    "reasons.productiveInsteadOfDraw",
    "reasons.higherScore",
  ];

  for (const language of ["en", "fr", "es"]) {
    const bundle = SOLITAIRE_REVIEW_TRANSLATIONS[language]?.recommendation;
    assert.ok(bundle, `${language} recommendation bundle is missing`);
    for (const key of keys) {
      const value = key
        .split(".")
        .reduce((node, part) => (node == null ? undefined : node[part]), bundle);
      assert.equal(typeof value, "string", `${language}.${key} is missing`);
      assert.ok(value.length > 0, `${language}.${key} is empty`);
    }
  }
});
