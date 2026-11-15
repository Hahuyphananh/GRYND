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
import { ACADEMY_VIDEOS } from "../src/lib/academyVideos.ts";
import {
  LESSON_CATALOG,
  LESSON_COURSES,
  lessonById,
  lessonsForCourse,
} from "../src/lib/solitaire-duel/lessonCatalog.ts";
import {
  applyLessonMove,
  createLessonSession,
  requestLessonHint,
  validateLessonCatalog,
} from "../src/lib/solitaire-duel/lessons.ts";
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
const CARDS = "src/components/learn/LearnCards.tsx";
const SUBNAV = "src/components/learn/LearnSubnav.tsx";
const COURSES = "src/components/learn/LearnCoursesPage.tsx";
const PRACTICE = "src/components/learn/LearnPracticePage.tsx";
const VIDEOS = "src/components/learn/LearnVideosPage.tsx";
const VIDEO_SECTION = "src/components/learn/AcademyVideoSection.tsx";
const VIDEO_PLAYER = "src/components/learn/VideoLessonPlayer.tsx";
const LEARN_PAGE = "src/app/learn/page.tsx";
const LESSON_PAGE = "src/app/learn/[lessonId]/page.tsx";
const COURSES_PAGE = "src/app/learn/courses/page.tsx";
const PRACTICE_PAGE = "src/app/learn/practice/page.tsx";
const VIDEOS_PAGE = "src/app/learn/videos/page.tsx";
const NAV = "src/components/navigation-bar.jsx";
const TUTORIAL = "src/components/solitaire-duel/SolitaireTutorial.tsx";

const landingSource = source(LANDING);
const playerSource = source(PLAYER);
const cardsSource = source(CARDS);
const subnavSource = source(SUBNAV);
const coursesSource = source(COURSES);
const practiceSource = source(PRACTICE);
const videosSource = source(VIDEOS);
const videoSectionSource = source(VIDEO_SECTION);
const videoPlayerSource = source(VIDEO_PLAYER);
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
  assert.equal(resolve(APP_TEXT_TRANSLATIONS.en, "nav.learn"), "Academy");
  assert.equal(resolve(APP_TEXT_TRANSLATIONS.fr, "nav.learn"), "Académie");
  assert.equal(resolve(APP_TEXT_TRANSLATIONS.es, "nav.learn"), "Academia");
});

test("the landing page is a concise hub with four destinations", () => {
  assert.match(landingSource, /learn\.title/);
  assert.match(landingSource, /learn\.progress\.title/);
  assert.match(landingSource, /recommendedLesson/);
  assert.match(landingSource, /learn\.continue\.kicker/);
  assert.match(landingSource, /learn\.destinations\.kicker/);
  assert.match(landingSource, /learn\.destinations\.courses\.title/);
  assert.match(landingSource, /learn\.destinations\.practice\.title/);
  assert.match(landingSource, /learn\.destinations\.videos\.title/);
  assert.match(landingSource, /learn\.destinations\.coaching\.title/);
  assert.match(landingSource, /testId="learn-destination-courses"/);
  assert.match(landingSource, /testId="learn-destination-practice"/);
  assert.match(landingSource, /testId="learn-destination-videos"/);
  assert.match(landingSource, /testId="learn-destination-coaching"/);
  assert.match(cardsSource, /data-testid="learn-course-card"/);
  assert.doesNotMatch(landingSource, /data-testid="learn-lesson-card"/);
  assert.doesNotMatch(landingSource, /AcademyVideoSection/);

  // A lesson is content, never a branch in the page.
  assert.doesNotMatch(landingSource, /"(first-draw|choose-an-ace|reveal-a-card)"/);
});

test("Courses, Practice and Videos are real destinations with routes", () => {
  for (const [file, component] of [
    [COURSES_PAGE, "LearnCoursesPage"],
    [PRACTICE_PAGE, "LearnPracticePage"],
    [VIDEOS_PAGE, "LearnVideosPage"],
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
    assert.match(source(file), new RegExp(component));
  }
  assert.match(subnavSource, /\/learn\/courses/);
  assert.match(subnavSource, /\/learn\/practice/);
  assert.match(subnavSource, /\/learn\/videos/);
  assert.match(subnavSource, /aria-current/);
  assert.match(source(COURSES_PAGE), /canonical: "\/learn\/courses"/);
  assert.match(source(PRACTICE_PAGE), /canonical: "\/learn\/practice"/);
  assert.match(source(VIDEOS_PAGE), /canonical: "\/learn\/videos"/);
});

test("the Courses page keeps courses, individual lessons and replay access", () => {
  assert.match(coursesSource, /CourseCard/);
  assert.match(coursesSource, /LessonCard/);
  assert.match(coursesSource, /LearnSubnav active="courses"/);
  assert.match(coursesSource, /courseFilter/);
  assert.match(coursesSource, /difficultyFilter/);
  assert.match(coursesSource, /statusFilter/);
  assert.match(cardsSource, /courseState/);
  assert.match(coursesSource, /lessonStatus/);
  assert.match(cardsSource, /learn.lesson.review/);
  assert.match(cardsSource, /data-testid="learn-course-card"/);
  assert.match(cardsSource, /data-testid="learn-lesson-card"/);
  assert.match(cardsSource, /learn\.path\.lockedHint/);
});

test("Practice is a working drill area on the shared board and engine", () => {
  assert.match(practiceSource, /LearnSubnav active="practice"/);
  assert.match(practiceSource, /<SolitaireBoard/);
  assert.match(practiceSource, /createPracticeSession/);
  assert.match(practiceSource, /applyPracticeMove/);
  assert.match(practiceSource, /practiceCategories/);
  assert.match(practiceSource, /testId="practice-category"/);
  assert.match(practiceSource, /testId="practice-skill"/);
  assert.match(practiceSource, /testId="practice-difficulty"/);
  assert.match(practiceSource, /data-testid="practice-start"/);
  assert.match(practiceSource, /data-testid="practice-another"/);
  assert.match(practiceSource, /data-testid="practice-return"/);
  assert.doesNotMatch(practiceSource, /comingTitle|comingBody/);
  assert.doesNotMatch(practiceSource, /onClick=\{\s*\(\)\s*=>\s*\{\s*\}\s*\}/);
});

test("Videos preserve the three video IDs and their related lessons", () => {
  assert.equal(ACADEMY_VIDEOS.length, 3);
  assert.deepEqual(
    ACADEMY_VIDEOS.map((video) => video.id),
    ["part-1", "part-2", "part-3"],
  );
  for (const video of ACADEMY_VIDEOS) {
    assert.ok(lessonById(video.lessonId), video.lessonId);
    assert.match(videoSectionSource, /relatedLesson/);
  }
  assert.match(videosSource, /AcademyVideoSection/);
  assert.match(videosSource, /LearnSubnav active="videos"/);
  assert.match(videoSectionSource, /useAcademyVideoProgress/);
  assert.doesNotMatch(videoSectionSource, /useLessonProgress/);
  assert.match(videoPlayerSource, /video-practice-lesson/);
  assert.match(videoPlayerSource, /href="\/learn\/videos"/);
});

test("the four destinations remain responsive and wrap on mobile", () => {
  assert.match(landingSource, /sm:grid-cols-2/);
  assert.match(landingSource, /lg:grid-cols-4/);
  assert.match(landingSource, /flex-wrap/);
  assert.match(coursesSource, /sm:grid-cols-2/);
  assert.match(coursesSource, /lg:grid-cols-3/);
  assert.match(subnavSource, /flex-wrap/);
  assert.match(practiceSource, /sm:grid-cols-2/);
});

test("the player uses the existing board, rules and engine", () => {
  assert.match(playerSource, /import SolitaireBoard from "\.\.\/solitaire-duel\/SolitaireBoard"/);
  assert.ok(playerSource.includes("viewForState(boardSession.state)"));
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

for (const match of `${landingSource}\n${playerSource}\n${cardsSource}\n${subnavSource}\n${coursesSource}\n${practiceSource}\n${videosSource}\n${videoSectionSource}\n${videoPlayerSource}\n${navSource}`.matchAll(
  /\bt\(\s*["']([^"']+)["']/g,
)) {
  // A concatenated key such as `learn.practice.difficulty.` + level + `.label`
  // is a dynamic prefix, not a literal key.
  if (!match[1].endsWith(".")) requiredKeys.add(match[1]);
}

// Dynamic labels that are selected from a value.
for (const difficulty of ["beginner", "intermediate", "advanced"]) {
  requiredKeys.add(`learn.difficulty.${difficulty}`);
}
for (const state of ["locked", "available", "completed", "notStarted", "inProgress", "done", "current", "upcoming"]) {
  requiredKeys.add(`learn.status.${state}`);
}
for (const section of ["courses", "practice", "videos"]) {
  requiredKeys.add(`learn.subnav.${section}`);
}
for (const category of ["tableau", "foundations", "stock-and-waste", "strategy"]) {
  requiredKeys.add(`learn.practice.categories.${category}.title`);
  requiredKeys.add(`learn.practice.categories.${category}.description`);
}
for (const key of [
  "kicker",
  "title",
  "description",
  "setupTitle",
  "start",
  "hint",
  "restart",
  "another",
  "backToSetup",
  "progressTitle",
  "guestNote",
  "accountNote",
]) {
  requiredKeys.add(`learn.practice.${key}`);
}
for (const difficulty of ["beginner", "intermediate", "advanced"]) {
  requiredKeys.add(`learn.practice.difficulty.${difficulty}.label`);
  requiredKeys.add(`learn.practice.difficulty.${difficulty}.description`);
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

// ── Lesson pacing ─────────────────────────────────────────────────────────

test("a correct move holds the next objective until Continue", () => {
  const lesson = lessonById("first-draw");
  const session = createLessonSession(lesson);
  const result = applyLessonMove(session, { kind: "draw" });

  assert.equal(result.accepted, true);
  assert.equal(result.advanced, true);
  assert.equal(result.feedback.kind, "correct");

  // The advanced session is held in feedback state instead of being committed.
  assert.match(playerSource, /const \[pendingAdvance, setPendingAdvance\]/);
  assert.match(
    playerSource,
    /setPendingAdvance\(\{ session: result\.session, feedback: result\.feedback \}\)/,
  );
  // The board cannot accept another lesson move during the pause.
  assert.match(playerSource, /interactive=\{!pendingAdvance && !session\.completed\}/);
  // The old immediate completion path (which skipped acknowledgement) is gone.
  assert.doesNotMatch(
    playerSource,
    /if \(result\.feedback\.kind === "complete"\) \{\s*finish\(\);/,
  );
});

test("Continue is the only advance path and is guarded against double clicks", () => {
  assert.match(playerSource, /const advanceLockRef = useRef\(false\)/);
  assert.match(
    playerSource,
    /if \(!pending \|\| advanceLockRef\.current\) return;/,
  );
  assert.match(playerSource, /advanceLockRef\.current = true;/);
  assert.match(playerSource, /if \(pending\.session\.completed\) \{/);
  assert.match(playerSource, /onClick=\{onContinue\}/);
  // No timeout or effect may advance the lesson on the player's behalf.
  assert.doesNotMatch(playerSource, /setTimeout\(/);
});

test("an off-goal legal move is explained and never advances", () => {
  const lesson = lessonById("first-draw");
  const session = createLessonSession(lesson);
  const result = applyLessonMove(session, {
    kind: "tableau-to-foundation",
    fromColumn: 0,
    card: { suit: "hearts", rank: 1 },
    suit: "hearts",
  });

  assert.equal(result.accepted, true, "the rules engine accepts the legal move");
  assert.equal(result.advanced, false);
  assert.equal(result.session.stepIndex, 0);
  assert.equal(result.session.log.length, 1, "experimentation is not rolled back");
  assert.equal(result.feedback.kind, "incorrect");
  assert.equal(result.feedback.reason, "off-goal");
  assert.ok(result.feedback.messageKey);
});

test("an illegal move is refused without corrupting the board", () => {
  const lesson = lessonById("first-draw");
  const session = createLessonSession(lesson);
  const result = applyLessonMove(session, {
    kind: "tableau-to-tableau",
    fromColumn: 0,
    card: { suit: "hearts", rank: 1 },
    toColumn: 1,
  });

  assert.equal(result.accepted, false);
  assert.equal(result.feedback.kind, "incorrect");
  assert.equal(result.feedback.reason, "illegal");
  assert.equal(result.session.log.length, 0);
  assert.deepEqual(result.session.state, session.state);
});

test("hints follow the current objective, get more specific, and never play the move", () => {
  const lesson = lessonById("first-draw");
  let session = createLessonSession(lesson);

  const first = requestLessonHint(session);
  session = first.session;
  assert.equal(first.hint.level, 1);
  assert.equal(first.hint.textKey, lesson.steps[0].hints[0].textKey);
  assert.equal(first.hint.solutionMove, null, "a normal hint does not reveal the move");
  assert.equal(session.stepIndex, 0);
  assert.equal(session.log.length, 0);

  const second = requestLessonHint(session);
  session = second.session;
  assert.equal(second.hint.level, 2);
  assert.ok(second.hint.solutionMove, "only the opt-in hint may offer the solution");
  assert.deepEqual(second.hint.solutionMove, { kind: "draw" });
  // Even after the solution hint the lesson is still the player's to complete.
  assert.equal(session.stepIndex, 0);
  assert.equal(session.log.length, 0);
});

test("the final objective is acknowledged before the completion screen", () => {
  const lesson = lessonById("tableau-basics");
  const session = createLessonSession(lesson);
  const result = applyLessonMove(session, {
    kind: "tableau-to-tableau",
    fromColumn: 2,
    card: { suit: "clubs", rank: 9 },
    toColumn: 0,
  });

  assert.equal(result.feedback.kind, "complete");
  assert.equal(result.session.completed, true);
  // The completion side effect is behind the pending acknowledgement.
  assert.match(
    playerSource,
    /if \(pending\.session\.completed\) \{[\s\S]{0,140}finish\(\);/,
  );
});

test("the full catalog still validates after the pacing change", () => {
  const validation = validateLessonCatalog(LESSON_CATALOG);
  assert.equal(validation.ok, true, validation.ok ? "" : validation.errors.join("\n"));
  assert.equal(LESSON_CATALOG.length, 20);
});

// ── Existing onboarding ───────────────────────────────────────────────────

test("the Learn section does not alter the onboarding tutorial", () => {
  const tutorial = source(TUTORIAL);
  assert.match(tutorial, /SolitaireTutorial/);
  assert.doesNotMatch(tutorial, /\/learn|lessonById|LearnLanding/);
  assert.match(tutorial, /applyTutorialMove/);
});
