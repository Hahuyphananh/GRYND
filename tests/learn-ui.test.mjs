// tests/learn-ui.test.mjs
//
// THE LEARN SECTION'S CONTRACT.
//
// The lesson engine already has its own tests. These cover the user-facing
// layer built on top of it:
//
//   * the /learn routes exist, use the shared navbar and launch the catalog;
//   * progress is local, per account, resettable and never invents lessons;
//   * course locking, recommendation and overall percentages are correct;
//   * every lesson/course/feedback key exists in EN, FR and ES with matching
//     interpolation placeholders;
//   * the player uses the existing board and lesson engine rather than a
//     second renderer or move validator;
//   * the onboarding tutorial remains untouched by the Learn section.
//
// Run: node --import tsx --test tests/learn-ui.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { APP_TEXT_TRANSLATIONS } from "../src/lib/appTextTranslations.js";
import { LEARN_TRANSLATIONS } from "../src/lib/learnTranslations.js";
import {
  LESSON_CATALOG,
  LESSON_COURSES,
  lessonsForCourse,
} from "../src/lib/solitaire-duel/lessonCatalog.ts";
import {
  LESSON_PROGRESS_STORAGE_PREFIX,
  courseProgress,
  courseState,
  emptyLessonProgress,
  isCourseComplete,
  isLessonCompleted,
  lessonProgressStorageKey,
  lessonStatus,
  lessonStepIndex,
  nextLessonAfter,
  normalizeLessonProgress,
  overallProgress,
  parseLessonProgress,
  readLessonProgress,
  recommendedLesson,
  recordLessonProgress,
  writeLessonProgress,
} from "../src/lib/solitaire-duel/lessonProgress.ts";

const ROOT = process.cwd();
const source = (relPath) =>
  fs.readFileSync(path.join(ROOT, relPath), "utf8").replace(/\r\n/g, "\n");

const LANDING = "src/components/learn/LearnLanding.tsx";
const PLAYER = "src/components/learn/LessonPlayer.tsx";
const LEARN_PAGE = "src/app/learn/page.tsx";
const LESSON_PAGE = "src/app/learn/[lessonId]/page.tsx";
const NAV = "src/components/navigation-bar.jsx";
const TUTORIAL = "src/components/solitaire-duel/SolitaireTutorial.tsx";

const landingSource = source(LANDING);
const playerSource = source(PLAYER);
const navSource = source(NAV);

const resolve = (bundle, key) =>
  key.split(".").reduce((value, part) => value?.[part], bundle);

function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

const advance = (progress, lessonId, stepIndex) =>
  recordLessonProgress(progress, { lessonId, stepIndex }, 1_700_000_000_000);

const complete = (progress, lessonId) =>
  recordLessonProgress(
    progress,
    { lessonId, stepIndex: LESSON_CATALOG.find((lesson) => lesson.id === lessonId).steps.length, completed: true },
    1_700_000_000_000,
  );

// ── Routes and composition ────────────────────────────────────────────────

test("the Learn routes exist and launch the catalog-driven components", () => {
  assert.ok(fs.existsSync(path.join(ROOT, LEARN_PAGE)));
  assert.ok(fs.existsSync(path.join(ROOT, LESSON_PAGE)));
  assert.match(source(LEARN_PAGE), /LearnLanding/);
  assert.match(source(LEARN_PAGE), /alternates: \{ canonical: "\/learn" \}/);
  assert.match(source(LESSON_PAGE), /lessonById\(lessonId\)/);
  assert.match(source(LESSON_PAGE), /notFound\(\)/);
  assert.match(source(LESSON_PAGE), /LessonPlayer/);
  assert.equal(fs.existsSync(path.join(ROOT, LANDING)), true);
  assert.equal(fs.existsSync(path.join(ROOT, PLAYER)), true);
});

test("Learn is reachable from both the desktop and mobile navigation", () => {
  const occurrences = navSource.match(/\"\/learn\"/g) ?? [];
  assert.ok(occurrences.length >= 3, "nav array, label and active check");
  assert.match(navSource, /if \(path === "\/learn"\) return t\("nav\.learn"\);/);
  // Guest experience: the middleware must let both /learn and /learn/<id>
  // through without sending a signed-out visitor to /sign-in.
  assert.match(source("src/proxy.ts"), /"\/learn\(\.\*\)"/);
  assert.equal(resolve(APP_TEXT_TRANSLATIONS.en, "nav.learn"), "Learn");
  assert.equal(resolve(APP_TEXT_TRANSLATIONS.fr, "nav.learn"), "Apprendre");
  assert.equal(resolve(APP_TEXT_TRANSLATIONS.es, "nav.learn"), "Aprender");
});

test("the landing page shows every required section without hardcoded lessons", () => {
  assert.match(landingSource, /learn\.title/);
  assert.match(landingSource, /learn\.progress\.title/);
  assert.match(landingSource, /recommendedLesson/);
  assert.match(landingSource, /learn\.continue\.kicker/);
  assert.match(landingSource, /courseState/);
  assert.match(landingSource, /learn\.path\.lockedHint/);
  assert.match(landingSource, /courseFilter/);
  assert.match(landingSource, /difficultyFilter/);
  assert.match(landingSource, /statusFilter/);
  assert.match(landingSource, /data-testid="learn-course-card"/);
  assert.match(landingSource, /data-testid="learn-lesson-card"/);

  // A lesson is content, never a branch in the page.
  assert.doesNotMatch(landingSource, /"(first-draw|choose-an-ace|reveal-a-card)"/);
});

test("the player uses the existing board, rules and engine", () => {
  assert.match(playerSource, /import SolitaireBoard from "\.\.\/solitaire-duel\/SolitaireBoard"/);
  assert.match(playerSource, /viewForState\(session\.state\)/);
  assert.match(playerSource, /applyLessonMove\(session, move\)/);
  assert.match(playerSource, /requestLessonHint\(session\)/);
  assert.match(playerSource, /restartLesson\(session\)/);
  assert.match(playerSource, /undoLessonMove\(session\)/);
  assert.match(playerSource, /<SolitaireBoard/);

  // No second renderer or validator.
  assert.doesNotMatch(playerSource, /PlayingCard|canPlaceOnTableau|normalizeMove/);
  assert.doesNotMatch(playerSource, /"(first-draw|choose-an-ace|reveal-a-card)"/);
});

test("the completion screen offers learning, course progress, replay and next steps", () => {
  for (const token of [
    "learn.player.completionTitle",
    "learn.player.whatLearned",
    "learn.player.courseProgress",
    "learn.player.nextLesson",
    "learn.player.replayLesson",
    "learn.player.returnToLearn",
    "onReplay",
  ]) {
    assert.match(playerSource, new RegExp(token.replace(/\./g, "\\.")), token);
  }
  assert.match(playerSource, /data-testid|IconCheck/);
});

// ── Progress model ────────────────────────────────────────────────────────

test("a fresh player has a full catalog, no completions and a first lesson", () => {
  const progress = emptyLessonProgress();
  const stats = overallProgress(progress);

  assert.equal(progress.completedLessonIds.length, 0);
  assert.equal(stats.completedLessons, 0);
  assert.equal(stats.totalLessons, LESSON_CATALOG.length);
  assert.equal(stats.completedSteps, 0);
  assert.equal(stats.totalSteps, LESSON_CATALOG.reduce((sum, lesson) => sum + lesson.steps.length, 0));
  assert.equal(stats.percent, 0);

  assert.equal(courseState(progress, "board-basics"), "available");
  assert.equal(courseState(progress, "moving-cards"), "locked");
  assert.equal(recommendedLesson(progress)?.id, "tableau-basics");
  assert.equal(lessonStatus(progress, LESSON_CATALOG[0]), "not-started");
});

test("step progress is tracked and a completed course unlocks the next one", () => {
  let progress = emptyLessonProgress();
  progress = advance(progress, "first-draw", 2);
  const firstDraw = LESSON_CATALOG.find((lesson) => lesson.id === "first-draw");

  assert.equal(lessonStatus(progress, firstDraw), "in-progress");
  assert.equal(lessonStepIndex(progress, firstDraw), 2);
  assert.equal(recommendedLesson(progress)?.id, "tableau-basics");
  assert.equal(
    overallProgress(progress).percent,
    Math.round((2 / overallProgress(progress).totalSteps) * 100),
  );
  assert.equal(courseState(progress, "moving-cards"), "locked");

  for (const lesson of lessonsForCourse("board-basics")) progress = complete(progress, lesson.id);
  assert.equal(isLessonCompleted(progress, "first-draw"), true);
  assert.equal(isCourseComplete(progress, "board-basics"), true);
  assert.equal(courseState(progress, "board-basics"), "completed");
  assert.equal(courseState(progress, "moving-cards"), "available");
  assert.equal(recommendedLesson(progress)?.id, "alternating-colors");
  assert.deepEqual(courseProgress(progress, "board-basics"), { completed: 4, total: 4 });
});

test("finishing the catalog reaches 100% and stops recommending a lesson", () => {
  let progress = emptyLessonProgress();
  for (const lesson of LESSON_CATALOG) progress = complete(progress, lesson.id);

  const stats = overallProgress(progress);
  assert.equal(stats.completedLessons, LESSON_CATALOG.length);
  assert.equal(stats.completedSteps, stats.totalSteps);
  assert.equal(stats.percent, 100);
  assert.equal(courseState(progress, "moving-cards"), "completed");
  assert.equal(recommendedLesson(progress), null);
  assert.equal(lessonStatus(progress, LESSON_CATALOG[2]), "completed");
});

test("completed lessons stay completed after a replay resets the step index", () => {
  let progress = emptyLessonProgress();
  progress = complete(progress, "alternating-colors");
  progress = advance(progress, "alternating-colors", 0);
  const lesson = LESSON_CATALOG.find((entry) => entry.id === "alternating-colors");

  assert.equal(isLessonCompleted(progress, "alternating-colors"), true);
  assert.equal(lessonStepIndex(progress, lesson), lesson.steps.length);
  assert.equal(courseProgress(progress, "moving-cards").completed, 1);
});

test("nextLessonAfter crosses course boundaries and stops at the end", () => {
  assert.equal(nextLessonAfter("tableau-basics")?.id, "first-draw");
  assert.equal(nextLessonAfter("first-draw")?.id, "building-foundations");
  assert.equal(nextLessonAfter("legal-moves")?.id, "alternating-colors");
  assert.equal(nextLessonAfter("difficult-positions"), null);
  assert.equal(nextLessonAfter("missing"), null);
});

// ── Storage and malformed payloads ────────────────────────────────────────

test("guests and signed-in accounts get separate local storage keys", () => {
  const storage = fakeStorage();
  const guest = advance(emptyLessonProgress(), "first-draw", 1);
  const account = complete(emptyLessonProgress(), "alternating-colors");

  writeLessonProgress(storage, null, guest);
  writeLessonProgress(storage, "user-123", account);

  assert.ok(storage.map.has(lessonProgressStorageKey(null)));
  assert.ok(storage.map.has(lessonProgressStorageKey("user-123")));
  assert.notEqual(
    lessonProgressStorageKey(null),
    lessonProgressStorageKey("user-123"),
  );
  assert.ok(lessonProgressStorageKey(null).startsWith(LESSON_PROGRESS_STORAGE_PREFIX));

  const firstDraw = LESSON_CATALOG.find((lesson) => lesson.id === "first-draw");
  assert.equal(lessonStatus(readLessonProgress(storage, null), firstDraw), "in-progress");
  assert.equal(
    isLessonCompleted(readLessonProgress(storage, "user-123"), "alternating-colors"),
    true,
  );
  assert.equal(readLessonProgress(storage, "someone-else").completedLessonIds.length, 0);
});

test("corrupt or stale progress is ignored safely", () => {
  assert.deepEqual(parseLessonProgress("{not json").completedLessonIds, []);
  assert.deepEqual(parseLessonProgress(null).completedLessonIds, []);

  const stale = normalizeLessonProgress({
    completedLessonIds: ["first-draw", "first-draw", "removed-lesson", 42],
    stepIndexByLesson: { "first-draw": 99, "removed-lesson": 2, "alternating-colors": -4 },
    lastLessonId: "removed-lesson",
    updatedAt: "yesterday",
  });
  assert.deepEqual(stale.completedLessonIds, ["first-draw"]);
  assert.equal(stale.stepIndexByLesson["removed-lesson"], undefined);
  assert.equal(stale.stepIndexByLesson["first-draw"], 99);
  assert.equal(stale.stepIndexByLesson["alternating-colors"], 0);
  assert.equal(stale.lastLessonId, null);
  assert.equal(stale.updatedAt, 0);
  // The read accessors clamp a stored index to the real lesson length.
  const firstDraw = LESSON_CATALOG.find((lesson) => lesson.id === "first-draw");
  assert.equal(lessonStepIndex(stale, firstDraw), firstDraw.steps.length);
});

test("unknown lesson ids cannot be recorded", () => {
  const progress = emptyLessonProgress();
  assert.strictEqual(
    recordLessonProgress(progress, { lessonId: "not-a-lesson", stepIndex: 1 }),
    progress,
  );
});

// ── Translations ──────────────────────────────────────────────────────────

const requiredKeys = new Set();

for (const match of `${landingSource}\n${playerSource}\n${navSource}`.matchAll(
  /\bt\(\s*["']([^"']+)["']/g,
)) {
  requiredKeys.add(match[1]);
}

// Dynamic labels that are selected from a value.
for (const difficulty of ["beginner", "intermediate", "advanced"]) {
  requiredKeys.add(`learn.difficulty.${difficulty}`);
}
for (const state of ["locked", "available", "completed", "notStarted", "inProgress", "done", "current", "upcoming"]) {
  requiredKeys.add(`learn.status.${state}`);
}

// Every key authored into the catalog, including steps and hints.
for (const course of LESSON_COURSES) {
  requiredKeys.add(course.titleKey);
  requiredKeys.add(course.descriptionKey);
}
for (const lesson of LESSON_CATALOG) {
  requiredKeys.add(lesson.titleKey);
  requiredKeys.add(lesson.descriptionKey);
  requiredKeys.add(lesson.successKey);
  for (const step of lesson.steps) {
    requiredKeys.add(step.instructionKey);
    requiredKeys.add(step.explanationKey);
    if (step.incorrectKey) requiredKeys.add(step.incorrectKey);
    for (const hint of step.hints ?? []) requiredKeys.add(hint.textKey);
  }
}
for (const key of [
  "learn.feedback.correct",
  "learn.feedback.complete",
  "learn.feedback.offGoal",
  "learn.feedback.illegal",
  "learn.feedback.alreadyComplete",
  "learn.feedback.noMoreHints",
]) {
  requiredKeys.add(key);
}

test("every Learn key exists in English, French and Spanish", () => {
  assert.ok(requiredKeys.size > 30);
  for (const lang of ["en", "fr", "es"]) {
    for (const key of requiredKeys) {
      const value = resolve(APP_TEXT_TRANSLATIONS[lang], key);
      assert.equal(
        typeof value,
        "string",
        `${lang} is missing ${key}`,
      );
      assert.ok(value.trim().length > 0, `${lang} has an empty ${key}`);
    }
  }
});

test("translations keep the same interpolation placeholders", () => {
  const placeholders = (value) =>
    [...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

  for (const key of requiredKeys) {
    const en = placeholders(resolve(APP_TEXT_TRANSLATIONS.en, key));
    for (const lang of ["fr", "es"]) {
      assert.deepEqual(
        placeholders(resolve(APP_TEXT_TRANSLATIONS[lang], key)),
        en,
        `${lang} placeholders differ for ${key}`,
      );
    }
  }
});

test("the Learn bundle is actually mounted in all three locales", () => {
  for (const lang of ["en", "fr", "es"]) {
    assert.equal(APP_TEXT_TRANSLATIONS[lang].learn, LEARN_TRANSLATIONS[lang]);
    assert.ok(APP_TEXT_TRANSLATIONS[lang].learn.player);
  }
  assert.equal(LESSON_COURSES.length, 5);
  assert.equal(lessonsForCourse("board-basics").length, 4);
  assert.equal(lessonsForCourse("moving-cards").length, 4);
});

// ── Existing onboarding ───────────────────────────────────────────────────

test("the Learn section does not alter the onboarding tutorial", () => {
  const tutorial = source(TUTORIAL);
  assert.match(tutorial, /SolitaireTutorial/);
  assert.doesNotMatch(tutorial, /\/learn|lessonById|LearnLanding/);
  assert.match(tutorial, /applyTutorialMove/);
});
