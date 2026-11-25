// tests/solitaire-review-practice.test.mjs
//
// PHASE 3 — Game Review → Practice contract.
//
// The mapping is pure: every assertion below drives the real Phase 1 analysis
// output, the real practice catalog and the real rules engine. The UI checks
// only verify that the pages use those helpers; they do not re-implement them.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { analyzeSolitaireGame } from "../src/lib/solitaire-duel/analysis.ts";
import { LESSON_BY_ID } from "../src/lib/solitaire-duel/lessonCatalog.ts";
import {
  applyPracticeMove,
  createPracticeSession,
  findPracticeExercise,
  practiceExerciseLesson,
  practiceSkill,
} from "../src/lib/solitaire-duel/practice.ts";
import { validateLessonDefinition } from "../src/lib/solitaire-duel/lessons.ts";
import {
  reviewPlyFromSearch,
  reviewPracticePlan,
  reviewPracticeSkill,
  reviewReturnPath,
} from "../src/lib/solitaire-duel/reviewPractice.ts";
import {
  PRACTICE_PROGRESS_STORAGE_PREFIX,
  emptyPracticeProgress,
  normalizePracticeProgress,
  practiceStats,
  recordPracticeAttempt,
  recordPracticeCompletion,
  recordPracticeHint,
} from "../src/lib/solitaire-duel/practiceProgress.ts";
import { LEARN_PRACTICE_TRANSLATIONS } from "../src/lib/learnPracticeTranslations.js";
import { SOLITAIRE_REVIEW_TRANSLATIONS } from "../src/lib/solitaireReviewTranslations.js";

const ROOT = process.cwd();
const read = (relative) =>
  fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");

const REVIEW_PAGE = "src/app/solitaire/review/[kind]/[gameId]/PageClient.tsx";
const PRACTICE_PAGE = "src/components/learn/LearnPracticePage.tsx";
const PRACTICE_ROUTE = "src/app/learn/practice/page.tsx";
const MAPPING = "src/lib/solitaire-duel/reviewPractice.ts";

const GAME_ID = "33333333-3333-4333-8333-333333333333";
const C = (suit, rank) => ({ suit, rank });
const P = (card, faceUp = true) => ({ card, faceUp });

const DEAL = {
  variant: "klondike-1",
  variantVersion: 3,
  tableau: [
    [P(C("spades", 5))],
    [P(C("spades", 2))],
    [P(C("clubs", 3))],
    [P(C("clubs", 4))],
    [P(C("clubs", 5))],
    [P(C("clubs", 6))],
    [P(C("clubs", 7))],
  ],
  stock: [C("hearts", 1)],
};
const MOVES = [
  { kind: "draw", move: { kind: "draw" } },
  { kind: "waste-to-tableau", move: { kind: "waste-to-tableau", toColumn: 1 } },
];
const ANALYSIS = analyzeSolitaireGame({ deal: DEAL, moves: MOVES });
const BASE = ANALYSIS.perMove[1].recommendation;
assert.ok(BASE, "the fixture must produce a real recommendation");

/** Build a recommendation with overridden evidence / move, same shape. */
function recommendation({ evidence = {}, ...overrides } = {}) {
  return { ...BASE, ...overrides, evidence: { ...BASE.evidence, ...evidence } };
}

function analysisFor(rec) {
  return {
    ...ANALYSIS,
    perMove: ANALYSIS.perMove.map((entry, index) =>
      index === 1 ? { ...entry, recommendation: rec } : entry,
    ),
  };
}

function planFor(rec, overrides = {}) {
  return reviewPracticePlan({
    analysis: analysisFor(rec),
    moveIndex: 1,
    kind: "solo",
    gameId: GAME_ID,
    ply: 2,
    ...overrides,
  });
}

const scopeOf = (exercise) => ({
  exerciseId: exercise.id,
  skillId: exercise.skillId,
  difficulty: exercise.difficulty,
});

// ── Concept mapping ───────────────────────────────────────────────────────

test("each supported recommendation maps to an existing practice skill", () => {
  const cases = [
    ["foundation-timing", recommendation({ evidence: { foundationGain: 1 } })],
    [
      "reveal-hidden-cards",
      recommendation({
        evidence: { foundationGain: 0, revealsGain: 1 },
      }),
    ],
    [
      "managing-kings",
      recommendation({
        evidence: { foundationGain: 0, revealsGain: 0, emptyColumnsGain: 0 },
        move: {
          kind: "tableau-to-tableau",
          fromColumn: 0,
          card: C("spades", 13),
          toColumn: 6,
        },
      }),
    ],
    [
      "opening-empty-columns",
      recommendation({
        evidence: { foundationGain: 0, revealsGain: 0, emptyColumnsGain: 1 },
      }),
    ],
    [
      "stock-cycle-planning",
      recommendation({
        evidence: { foundationGain: 0, revealsGain: 0, emptyColumnsGain: 0 },
        played: { kind: "draw" },
      }),
    ],
    [
      "comparing-alternative-moves",
      recommendation({
        evidence: { foundationGain: 0, revealsGain: 0, emptyColumnsGain: 0 },
      }),
    ],
  ];

  for (const [expected, rec] of cases) {
    assert.equal(reviewPracticeSkill(rec), expected);
    assert.ok(practiceSkill(expected), expected);
    const plan = planFor(rec);
    assert.ok(plan, expected);
    assert.equal(plan.skillId, expected);
    assert.equal(practiceSkill(plan.skillId).categoryId, plan.categoryId);
  }
});

test("unsupported recommendations produce no plan and no button", () => {
  assert.equal(reviewPracticeSkill(null), null);
  assert.equal(
    reviewPracticePlan({
      analysis: null,
      moveIndex: 0,
      kind: "solo",
      gameId: GAME_ID,
      ply: 1,
    }),
    null,
  );
  assert.equal(planFor(null), null);
  // Out-of-range plies and an analysis without this move are unsupported too.
  assert.equal(
    reviewPracticePlan({
      analysis: ANALYSIS,
      moveIndex: 99,
      kind: "solo",
      gameId: GAME_ID,
      ply: 2,
    }),
    null,
  );
  assert.equal(planFor(BASE, { moveIndex: -1 }), null);
});

// ── Valid positions and legal moves ───────────────────────────────────────

test("the selected exercise is validator-approved and its line is legal", () => {
  const skills = [
    "foundation-timing",
    "reveal-hidden-cards",
    "managing-kings",
    "opening-empty-columns",
    "stock-cycle-planning",
    "comparing-alternative-moves",
  ];
  const recs = {
    "foundation-timing": recommendation({ evidence: { foundationGain: 1 } }),
    "reveal-hidden-cards": recommendation({
      evidence: { foundationGain: 0, revealsGain: 1 },
    }),
    "managing-kings": recommendation({
      evidence: { foundationGain: 0, revealsGain: 0, emptyColumnsGain: 0 },
      move: {
        kind: "tableau-to-tableau",
        fromColumn: 0,
        card: C("spades", 13),
        toColumn: 6,
      },
    }),
    "opening-empty-columns": recommendation({
      evidence: { foundationGain: 0, revealsGain: 0, emptyColumnsGain: 1 },
    }),
    "stock-cycle-planning": recommendation({
      evidence: { foundationGain: 0, revealsGain: 0, emptyColumnsGain: 0 },
      played: { kind: "draw" },
    }),
    "comparing-alternative-moves": recommendation({
      evidence: { foundationGain: 0, revealsGain: 0, emptyColumnsGain: 0 },
    }),
  };

  for (const skillId of skills) {
    const plan = planFor(recs[skillId]);
    const exercise = findPracticeExercise(plan.exerciseId);
    assert.ok(exercise, skillId);
    assert.equal(exercise.skillId, skillId);
    assert.equal(exercise.difficulty, plan.difficulty);

    const validated = validateLessonDefinition(practiceExerciseLesson(exercise));
    assert.equal(validated.ok, true, `${skillId}: ${JSON.stringify(validated.errors ?? [])}`);

    let session = createPracticeSession(exercise);
    for (const move of exercise.solutions[0]) {
      const result = applyPracticeMove(session, move);
      assert.equal(result.accepted, true, `${skillId} rejected an authored move`);
      session = result.session;
    }
    assert.equal(session.completed, true, skillId);
  }
});

test("a drill with multiple acceptable lines still accepts every line", () => {
  const plan = planFor(
    recommendation({
      evidence: { foundationGain: 0, revealsGain: 0, emptyColumnsGain: 0 },
    }),
  );
  const exercise = findPracticeExercise(plan.exerciseId);
  assert.equal(exercise.solutions.length, 2);
  for (const line of exercise.solutions) {
    let session = createPracticeSession(exercise);
    for (const move of line) session = applyPracticeMove(session, move).session;
    assert.equal(session.completed, true);
  }
});

// ── Hidden information and return context ─────────────────────────────────

test("the plan carries ids and links only — no deal, seed or card identity", () => {
  const plan = planFor(recommendation({ evidence: { foundationGain: 1 } }));
  const serialized = JSON.stringify(plan).toLowerCase();
  for (const forbidden of ["deal", "seed", "suit", "rank", "faceup", "tableau", "stock"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(Object.keys(plan).sort(), [
    "categoryId",
    "difficulty",
    "exerciseId",
    "lessonId",
    "practiceHref",
    "reviewHref",
    "skillId",
  ]);
});

test("the practice link encodes the exact review path and ply", () => {
  const plan = planFor(recommendation({ evidence: { foundationGain: 1 } }));
  const url = new URL(plan.practiceHref, "https://grynd.local");
  assert.equal(url.pathname, "/learn/practice");
  assert.equal(url.searchParams.get("skill"), plan.skillId);
  assert.equal(url.searchParams.get("difficulty"), plan.difficulty);
  assert.equal(url.searchParams.get("auto"), "1");
  assert.equal(url.searchParams.get("from"), plan.reviewHref);
  assert.equal(plan.reviewHref, `/solitaire/review/solo/${GAME_ID}?ply=2`);
});

test("only a same-origin review path is accepted as a return target", () => {
  assert.equal(
    reviewReturnPath(`/solitaire/review/solo/${GAME_ID}?ply=2`),
    `/solitaire/review/solo/${GAME_ID}?ply=2`,
  );
  for (const rejected of [
    `https://evil.example/solitaire/review/solo/${GAME_ID}`,
    `//evil.example/solitaire/review/solo/${GAME_ID}`,
    "/learn/practice?skill=foundation-timing",
    "/solitaire/review/solo/../../admin",
    `/solitaire/review/solo/${GAME_ID}?ply=abc`,
    `/solitaire\\review\\solo\\${GAME_ID}`,
    "",
    null,
    undefined,
  ]) {
    assert.equal(reviewReturnPath(rejected), null, String(rejected));
  }
});

test("the reviewed ply is restored and clamped to the real log", () => {
  assert.equal(reviewPlyFromSearch("?ply=2", 2), 2);
  assert.equal(reviewPlyFromSearch("?ply=99", 2), 2);
  assert.equal(reviewPlyFromSearch("?ply=-1", 2), 0);
  assert.equal(reviewPlyFromSearch("?ply=abc", 2), 0);
  assert.equal(reviewPlyFromSearch("", 2), 0);
  assert.equal(reviewPlyFromSearch("?ply=1", 0), 0);
});

// ── Academy links ─────────────────────────────────────────────────────────

test("every connected lesson exists in the real catalog", () => {
  const plans = [
    planFor(recommendation({ evidence: { foundationGain: 1 } })),
    planFor(recommendation({ evidence: { foundationGain: 0, revealsGain: 1 } })),
    planFor(
      recommendation({
        evidence: { foundationGain: 0, revealsGain: 0, emptyColumnsGain: 0 },
        move: {
          kind: "tableau-to-tableau",
          fromColumn: 0,
          card: C("spades", 13),
          toColumn: 6,
        },
      }),
    ),
    planFor(recommendation({ evidence: { foundationGain: 0, revealsGain: 0, emptyColumnsGain: 1 } })),
    planFor(
      recommendation({
        evidence: { foundationGain: 0, revealsGain: 0, emptyColumnsGain: 0 },
        played: { kind: "draw" },
      }),
    ),
    planFor(
      recommendation({
        evidence: { foundationGain: 0, revealsGain: 0, emptyColumnsGain: 0 },
      }),
    ),
  ];
  for (const plan of plans) {
    assert.ok(plan.lessonId, plan.skillId);
    assert.ok(LESSON_BY_ID[plan.lessonId], `${plan.lessonId} is not in the catalog`);
  }
});

// ── Progress, isolated from every competitive record ──────────────────────

test("review-origin practice is counted in its own bucket", () => {
  const exercise = findPracticeExercise("foundation-timing");
  const scope = scopeOf(exercise);

  let progress = emptyPracticeProgress();
  progress = recordPracticeAttempt(progress, { ...scope, source: "review" }, 1);
  progress = recordPracticeHint(progress, { ...scope, source: "review" }, 2);
  progress = recordPracticeCompletion(progress, { ...scope, source: "review" }, 3);
  progress = recordPracticeAttempt(progress, { ...scope, source: "catalog" }, 4);

  const stats = practiceStats(progress);
  assert.equal(stats.attempts, 2, "catalog and review still add to the same total");
  assert.equal(stats.completions, 1);
  assert.equal(stats.hints, 1);
  assert.deepEqual(stats.fromReview, { attempts: 1, completions: 1, hints: 1 });
  assert.deepEqual(progress.bySource.catalog, { attempts: 1, completions: 0, hints: 0 });
  assert.deepEqual(progress.byExercise[exercise.id], {
    attempts: 2,
    completions: 1,
    hints: 1,
  });
});

test("a scope without a source stays catalog practice", () => {
  const exercise = findPracticeExercise("reveal-hidden-cards");
  const progress = recordPracticeAttempt(emptyPracticeProgress(), scopeOf(exercise));
  assert.deepEqual(progress.bySource.catalog, { attempts: 1, completions: 0, hints: 0 });
  assert.deepEqual(progress.bySource.review, { attempts: 0, completions: 0, hints: 0 });
});

test("stored review buckets are normalized and legacy records still load", () => {
  const legacy = normalizePracticeProgress({
    attempts: 4,
    completions: 2,
    hints: 1,
    byExercise: { "foundation-timing": { attempts: 4, completions: 2, hints: 1 } },
  });
  assert.deepEqual(legacy.bySource, {
    catalog: { attempts: 0, completions: 0, hints: 0 },
    review: { attempts: 0, completions: 0, hints: 0 },
  });
  assert.equal(legacy.attempts, 4);

  const stored = normalizePracticeProgress({
    bySource: {
      review: { attempts: 2, completions: 1, hints: 1 },
      catalog: { attempts: 3, completions: 2, hints: 0 },
      forged: { attempts: 99, completions: 99, hints: 99 },
    },
  });
  assert.deepEqual(stored.bySource.review, { attempts: 2, completions: 1, hints: 1 });
  assert.deepEqual(stored.bySource.catalog, { attempts: 3, completions: 2, hints: 0 });
  assert.equal(Object.keys(stored.bySource).length, 2);
});

test("the practice store has no competitive write path", () => {
  assert.match(PRACTICE_PROGRESS_STORAGE_PREFIX, /practice/);
  for (const file of [MAPPING, PRACTICE_PAGE, PRACTICE_ROUTE, REVIEW_PAGE]) {
    const source = read(file);
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*(serverStore|trophy|elo|rating|leaderboard)/i,
      file,
    );
    assert.doesNotMatch(source, /trophyAward|recordRanked|updateElo|localMatch/, file);
  }
  assert.doesNotMatch(read(MAPPING), /\bfetch\s*\(/);
});

// ── Composition ───────────────────────────────────────────────────────────

test("the review panel offers the drill and a real lesson only with a plan", () => {
  const source = read(REVIEW_PAGE);
  assert.match(source, /reviewPracticePlan/);
  assert.match(source, /reviewPlyFromSearch/);
  assert.match(source, /data-testid="review-practice-situation"/);
  assert.match(source, /data-testid="review-recommendation-lesson"/);
  assert.match(source, /practicePlan\.lessonId/);
  assert.match(source, /data-lesson=/);
  assert.match(source, /reviewPlyFromSearch\(window\.location\.search/);
});

test("Practice shows the review origin and returns to the reviewed ply", () => {
  const page = read(PRACTICE_PAGE);
  assert.match(page, /reviewReturnPath/);
  assert.match(page, /initialAutoStart/);
  assert.match(page, /isProgressLoaded/);
  assert.match(page, /practice-review-context/);
  assert.match(page, /practice-back-to-review/);
  assert.match(page, /practice-review-progress/);
  assert.match(page, /practice-review-why/);
  assert.match(page, /source,/);

  const route = read(PRACTICE_ROUTE);
  assert.match(route, /initialFromReview/);
  assert.match(route, /initialAutoStart/);
  assert.match(route, /params\.from/);
  assert.match(route, /params\.auto/);
});

test("Phase 3 copy exists in English, French and Spanish", () => {
  const practiceKeys = [
    "fromReviewKicker",
    "fromReviewTitle",
    "fromReviewBody",
    "backToReview",
    "fromReviewProgress",
  ];
  const reviewKeys = ["practiceCta", "practiceNote", "practiceLessonCta"];

  for (const language of ["en", "fr", "es"]) {
    for (const key of practiceKeys) {
      const value = LEARN_PRACTICE_TRANSLATIONS[language]?.[key];
      assert.equal(typeof value, "string", `${language} ${key}`);
      assert.ok(value.trim().length > 0, `${language} ${key}`);
    }
    for (const key of reviewKeys) {
      const value = SOLITAIRE_REVIEW_TRANSLATIONS[language]?.recommendation?.[key];
      assert.equal(typeof value, "string", `${language} ${key}`);
      assert.ok(value.trim().length > 0, `${language} ${key}`);
    }
  }
  assert.notEqual(
    LEARN_PRACTICE_TRANSLATIONS.fr.fromReviewTitle,
    LEARN_PRACTICE_TRANSLATIONS.en.fromReviewTitle,
  );
  assert.notEqual(
    LEARN_PRACTICE_TRANSLATIONS.es.fromReviewTitle,
    LEARN_PRACTICE_TRANSLATIONS.en.fromReviewTitle,
  );
});
