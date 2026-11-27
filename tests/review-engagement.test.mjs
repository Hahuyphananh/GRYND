/**
 * review-engagement.test.mjs
 *
 * Phase 5 pins for Game Review → practice → repeat play:
 *   * review completion is measured when the closing summary is SEEN;
 *   * the practice CTA reports the skill/exercise it will open;
 *   * a practice drill reports start AND completion, attributable to a review;
 *   * post-game entry points still link to the review;
 *   * nothing leaks a hidden card through the review-to-practice bridge, and
 *     no comparison is claimed from a single game.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  ALLOWED_PROPERTY_KEYS,
  SOLITAIRE_EVENTS,
  sanitizeSolitaireProperties,
} from "../src/lib/solitaire-analytics.ts";
import { reviewPracticePlan } from "../src/lib/solitaire-duel/reviewPractice.ts";
import { personalBestComparison } from "../src/lib/solitaire-duel/reviewSummary.ts";

const read = (path) => fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const REVIEW_PAGE = "src/app/solitaire/review/[kind]/[gameId]/PageClient.tsx";
const PRACTICE_PAGE = "src/components/learn/LearnPracticePage.tsx";

test("review completion and practice click belong to the taxonomy", () => {
  assert.equal(SOLITAIRE_EVENTS.reviewCompleted, "solitaire_review_completed");
  assert.equal(SOLITAIRE_EVENTS.reviewPracticeClicked, "review_practice_clicked");
  assert.equal(SOLITAIRE_EVENTS.practiceDrillStarted, "practice_drill_started");
  assert.equal(SOLITAIRE_EVENTS.practiceDrillCompleted, "practice_drill_completed");
  assert.ok(ALLOWED_PROPERTY_KEYS.includes("skill_id"));
  assert.ok(ALLOWED_PROPERTY_KEYS.includes("exercise_id"));
});

test("drill identifiers are allowlisted and bounded", () => {
  const clean = sanitizeSolitaireProperties({
    surface: "practice",
    source: "review",
    skill_id: "foundation-timing",
    exercise_id: "foundation-timing-beginner-1",
  });
  assert.equal(clean.skill_id, "foundation-timing");
  assert.equal(clean.exercise_id, "foundation-timing-beginner-1");
  // Unknown keys still never pass through.
  assert.equal("deal" in sanitizeSolitaireProperties({ deal: ["AS"] }), false);
});

test("review completion fires when the closing summary is visible, once", () => {
  const src = read(REVIEW_PAGE);
  assert.match(src, /new IntersectionObserver\(/);
  assert.match(src, /`review_completed:\$\{kind\}:\$\{gameId\}`/);
  assert.match(src, /SOLITAIRE_EVENTS\.reviewCompleted/);
  assert.match(src, /threshold: 0\.4/);
  assert.match(src, /ref=\{summaryRef\}/);
  // Opening alone does not complete a review.
  assert.match(src, /`review_opened:\$\{kind\}:\$\{gameId\}`/);
});

test("the practice CTA reports the exact skill and exercise", () => {
  const src = read(REVIEW_PAGE);
  assert.match(src, /SOLITAIRE_EVENTS\.reviewPracticeClicked/);
  assert.match(src, /skill_id: practicePlan\.skillId/);
  assert.match(src, /exercise_id: practicePlan\.exerciseId/);
  assert.match(src, /surface: "review"/);
});

test("practice drills emit start and completion with their source", () => {
  const src = read(PRACTICE_PAGE);
  assert.match(src, /SOLITAIRE_EVENTS\.practiceDrillStarted/);
  assert.match(src, /SOLITAIRE_EVENTS\.practiceDrillCompleted/);
  assert.match(src, /skill_id: exercise\.skillId/);
  assert.match(src, /skill_id: active\.exercise\.skillId/);
  assert.match(src, /source,\n\s+skill_id/);
});

test("post-game surfaces still lead to the review", () => {
  const timeline = read("src/components/solitaire-duel/MatchTimeline.tsx");
  assert.match(timeline, /data-testid="match-timeline-review-link"/);
  assert.match(timeline, /Open full match review/);

  const solo = read("src/components/solitaire-duel/SoloSolitaireGame.tsx");
  assert.match(solo, /\/solitaire\/review\/\$\{session\.mode\}/);
  assert.match(solo, /solitaire-history-review-/);
});

test("the practice bridge carries ids only — never a deal or a card", () => {
  const plan = reviewPracticePlan({
    analysis: {
      perMove: [
        {
          ply: 0,
          rating: "mistake",
          recommendation: {
            ply: 0,
            move: { kind: "draw" },
            evidence: { foundationGain: 1, revealsGain: 0, emptyColumnsGain: 0 },
            played: { kind: "tableau-to-tableau" },
          },
        },
      ],
    },
    moveIndex: 0,
    kind: "solo",
    gameId: "abc",
    ply: 1,
  });
  assert.ok(plan, "a supported mistake yields a plan");
  for (const value of Object.values(plan)) {
    if (typeof value !== "string") continue;
    assert.doesNotMatch(value, /seed|deal|card|suit|rank/i);
  }
  assert.ok(plan.practiceHref.startsWith("/learn/practice?"));
  assert.match(plan.practiceHref, /from=%2Fsolitaire%2Freview%2Fsolo%2Fabc/);
});

test("no comparison is claimed from a single completed game", () => {
  assert.equal(
    personalBestComparison({ durationMs: 60_000, bestMs: 60_000, completedGames: 1 }),
    null,
  );
  assert.equal(
    personalBestComparison({ durationMs: 60_000, bestMs: 50_000, completedGames: 2 })?.relation,
    "behind",
  );
});
