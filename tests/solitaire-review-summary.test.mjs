/**
 * solitaire-review-summary.test.mjs
 *
 * Phase 4 — closing summary, highlights, Academy / Practice links and
 * personal-best comparison. Pure behavior plus source contracts.
 *
 * Run: node --import tsx --test tests/solitaire-review-summary.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  meaningfulInsightCount,
  personalBestComparison,
  reviewFoundationCount,
  reviewHighlights,
  reviewLearningFor,
  reviewLearningForHighlights,
} from "../src/lib/solitaire-duel/reviewSummary.ts";
import { LESSON_BY_ID } from "../src/lib/solitaire-duel/lessonCatalog.ts";
import {
  practiceDifficultiesFor,
  practiceExercisesFor,
  practiceSkill,
} from "../src/lib/solitaire-duel/practice.ts";
import { replayMoves } from "../src/lib/solitaire-duel/rules.ts";
import { solvableDealFromSeed, solveDealLine } from "../src/lib/solitaire-duel/solvable.ts";
import { APP_TEXT_TRANSLATIONS } from "../src/lib/appTextTranslations.js";

const read = (path) => fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const PAGE = "src/app/solitaire/review/[kind]/[gameId]/PageClient.tsx";

const DEAL = solvableDealFromSeed(7);
const LINE = solveDealLine(DEAL) ?? [];
const MOVES = LINE.map((move) => ({ kind: move.kind, move }));

test("foundation total is the final replayed board, not a move count", () => {
  assert.equal(reviewFoundationCount(DEAL, MOVES), 52);
  assert.equal(reviewFoundationCount(DEAL, []), 0);
  assert.equal(
    reviewFoundationCount(DEAL, [{ kind: "not-a-move", move: { kind: "not-a-move" } }]),
    null,
  );
  assert.equal(reviewFoundationCount(null, MOVES), null);
});

test("meaningful insights count only supported engine labels", () => {
  const analysis = {
    perMove: [
      { rating: "great" },
      { rating: "good" },
      { rating: "inaccuracy" },
      { rating: "mistake" },
      { rating: "normal" },
      { rating: "brilliant" },
      { rating: "blunder" },
    ],
  };
  assert.equal(meaningfulInsightCount(analysis), 4);
  assert.equal(meaningfulInsightCount(null), null);
});

test("highlights are real moves, capped and presented in replay order", () => {
  const analysis = {
    perMove: [
      { ply: 0, rating: "normal", tags: ["stock-draw"] },
      { ply: 1, rating: "good", tags: ["revealed-hidden"] },
      { ply: 2, rating: "great", tags: ["opened-column"] },
      { ply: 3, rating: "inaccuracy", tags: ["wasted-redeal"] },
      { ply: 4, rating: "mistake", tags: ["pointless-shuffle"] },
      { ply: 5, rating: "normal", tags: ["opened-column"] },
      { ply: 6, rating: "brilliant", tags: ["unlocked-sequence"] },
      { ply: 7, rating: "blunder", tags: ["foundation-cascade"] },
    ],
  };
  const highlights = reviewHighlights(analysis, 8, 4);
  assert.deepEqual(
    highlights.map((highlight) => highlight.ply),
    [1, 2, 3, 4],
  );
  assert.equal(
    highlights.some((highlight) => highlight.rating === "brilliant"),
    false,
  );
  assert.equal(reviewHighlights(analysis, 8, 0).length, 0);
  assert.deepEqual(reviewHighlights(null, 8), []);
});

test("a normal structural reveal can be a highlight without a quality label", () => {
  const analysis = {
    perMove: [{ ply: 2, rating: "normal", tags: ["unlocked-sequence"] }],
  };
  const highlights = reviewHighlights(analysis, 5);
  assert.equal(highlights.length, 1);
  assert.equal(highlights[0].rating, "normal");
});

test("learning links use verified Academy lesson ids", () => {
  const tags = ["revealed-hidden", "opened-column"];
  const link = reviewLearningFor(tags);
  assert.ok(link);
  assert.equal(link.lessonId, "reveal-a-card");
  assert.equal(Boolean(LESSON_BY_ID[link.lessonId]), true);
  assert.match(link.reasonKey, /^solitaireReview\.learning\.why\./);
});

test("every learning relationship points at a real lesson and real practice", () => {
  const allTags = [
    "revealed-hidden",
    "opened-column",
    "unlocked-sequence",
    "king-to-empty-column",
    "foundation-cascade",
    "pulled-from-foundation",
    "pointless-shuffle",
    "wasted-redeal",
    "foundation-progress",
  ];
  for (const tag of allTags) {
    const link = reviewLearningFor([tag]);
    assert.ok(link, `missing learning link for ${tag}`);
    assert.ok(LESSON_BY_ID[link.lessonId], `${tag} points at missing lesson ${link.lessonId}`);
    if (link.practiceSkillId) {
      assert.ok(
        practiceSkill(link.practiceSkillId),
        `${tag} points at missing practice skill ${link.practiceSkillId}`,
      );
      assert.ok(
        practiceExercisesFor(link.practiceSkillId).length > 0,
        `${tag} practice skill has no validated exercise`,
      );
      assert.ok(
        practiceDifficultiesFor(link.practiceSkillId).length > 0,
        `${tag} practice skill has no difficulty`,
      );
    }
  }
});

test("an unrelated tag gets no invented recommendation", () => {
  assert.equal(reviewLearningFor(["stock-draw"]), null);
  assert.equal(reviewLearningFor([]), null);
  assert.equal(reviewLearningFor(null), null);
  assert.equal(
    reviewLearningForHighlights([
      { ply: 0, rating: "normal", tags: ["stock-draw"] },
    ]),
    null,
  );
});

test("the first mapped highlight supplies exactly one recommendation", () => {
  const link = reviewLearningForHighlights([
    { ply: 0, rating: "normal", tags: ["stock-draw"] },
    { ply: 3, rating: "great", tags: ["opened-column"] },
  ]);
  assert.ok(link);
  assert.equal(link.lessonId, "opening-columns");
});

test("personal best only compares same-mode completed history", () => {
  assert.equal(
    personalBestComparison({ durationMs: 61_000, bestMs: 61_000, completedGames: 4 })?.relation,
    "matched",
  );
  assert.equal(
    personalBestComparison({ durationMs: 90_000, bestMs: 61_000, completedGames: 4 })?.deltaMs,
    29_000,
  );
  assert.equal(
    personalBestComparison({ durationMs: 61_000, bestMs: 61_000, completedGames: 1 }),
    null,
  );
  assert.equal(
    personalBestComparison({ durationMs: null, bestMs: 61_000, completedGames: 4 }),
    null,
  );
  assert.equal(
    personalBestComparison({ durationMs: 61_000, bestMs: null, completedGames: 4 }),
    null,
  );
});

test("all three locales expose the summary and recommendation copy", () => {
  const required = [
    "modes.solo",
    "modes.daily",
    "modes.duel",
    "status.complete",
    "summary.title",
    "summary.mode",
    "summary.status",
    "summary.moves",
    "summary.duration",
    "summary.foundations",
    "summary.insights",
    "summary.personalBestMatched",
    "summary.personalBestBehind",
    "summary.personalBestUnavailable",
    "summary.analysisUnavailable",
    "summary.noInsightsComplete",
    "summary.close",
    "summary.heuristic",
    "highlights.title",
    "highlights.empty",
    "learning.title",
    "learning.lessonCta",
    "learning.practiceCta",
    "learning.why.reveal",
    "learning.why.open",
    "learning.why.king",
    "learning.why.cascade",
    "learning.why.keep",
    "learning.why.plan",
    "learning.why.stock",
    "learning.why.foundation",
    "tags.revealed-hidden",
    "tags.opened-column",
  ];
  for (const locale of ["en", "fr", "es"]) {
    const block = APP_TEXT_TRANSLATIONS[locale]?.solitaireReview;
    assert.ok(block, `${locale} has no solitaireReview block`);
    for (const key of required) {
      const value = key.split(".").reduce((value, part) => value?.[part], block);
      assert.equal(typeof value, "string", `${locale} missing ${key}`);
      assert.ok(value.length > 0, `${locale} has empty ${key}`);
    }
  }
});

test("the page links to the real Academy and Practice routes", () => {
  const source = read(PAGE);
  assert.ok(source.includes('data-testid="review-completion-summary"'));
  assert.ok(source.includes('href={`/learn/${learning.lessonId}`}'));
  assert.ok(source.includes('href={`/learn/practice?skill=${encodeURIComponent(learning.practiceSkillId)}`}'));
  assert.ok(source.includes('data-testid="review-close"'));
  assert.ok(source.includes("personalBestComparison"));
  assert.ok(source.includes("reviewFoundationCount"));
});

test("the summary never writes lesson or practice progress", () => {
  const source = read(PAGE);
  for (const writer of [
    "recordLessonProgress",
    "recordPracticeProgress",
    "writeLessonProgress",
    "writePracticeProgress",
    "notifyLessonProgressChanged",
  ]) {
    assert.equal(source.includes(writer), false, `review page must not call ${writer}`);
  }
});
