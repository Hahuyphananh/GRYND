// tests/solitaire-practice.test.mjs
//
// THE INDEPENDENT PRACTICE CONTRACT.
//
// These tests drive the real lesson/rules engine through the practice catalog:
// catalog validation (a drill is published only if the lesson validator accepts
// it AND an authored solution replays to its objective), category/difficulty
// selection, exercise initialization, move validation, completion, hints,
// restart, the next-exercise rotation, local progress for guests and accounts,
// and isolation from every competitive record.
//
// The component assertions only verify composition: Practice renders with the
// shared SolitaireBoard and calls the engine — it does not re-implement cards,
// moves or board state.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { APP_TEXT_TRANSLATIONS } from "../src/lib/appTextTranslations.js";
import { LEARN_TRANSLATIONS } from "../src/lib/learnTranslations.js";
import { LEARN_PRACTICE_TRANSLATIONS } from "../src/lib/learnPracticeTranslations.js";
import { validateLessonDefinition } from "../src/lib/solitaire-duel/lessons.ts";
import { viewForState } from "../src/lib/solitaire-duel/rules.ts";
import {
  PRACTICE_CATEGORIES,
  PRACTICE_DIFFICULTIES,
  PRACTICE_SKILLS,
  VALIDATED_PRACTICE_EXERCISES,
  applyPracticeMove,
  createPracticeSession,
  findPracticeExercise,
  nextPracticeExercise,
  practiceCatalogSummary,
  practiceCategories,
  practiceCategoryCount,
  practiceDifficultiesFor,
  practiceExerciseCount,
  practiceExerciseLesson,
  practiceExercisesFor,
  practiceSkillsForCategory,
  practiceSolutionMove,
  requestPracticeHint,
  restartPractice,
  undoPracticeMove,
} from "../src/lib/solitaire-duel/practice.ts";
import {
  emptyPracticeProgress,
  normalizePracticeProgress,
  practiceProgressStorageKey,
  practiceStats,
  readPracticeProgress,
  recordPracticeAttempt,
  recordPracticeCompletion,
  recordPracticeHint,
  writePracticeProgress,
} from "../src/lib/solitaire-duel/practiceProgress.ts";
import { LESSON_PROGRESS_STORAGE_PREFIX } from "../src/lib/solitaire-duel/lessonProgress.ts";

const ROOT = process.cwd();
const read = (relative) =>
  fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");
const resolve = (bundle, key) =>
  key.split(".").reduce((value, part) => value?.[part], bundle);
// LEARN_TRANSLATIONS is the bundle mounted under `learn`, so practice keys
// resolve after stripping that one prefix.
const resolvePractice = (language, key) =>
  resolve(LEARN_TRANSLATIONS[language], key.replace(/^learn\./, ""));

const PRACTICE_SOURCE = "src/lib/solitaire-duel/practice.ts";
const PROGRESS_SOURCE = "src/lib/solitaire-duel/practiceProgress.ts";
const HOOK_SOURCE = "src/hooks/usePracticeProgress.ts";
const PAGE_SOURCE = "src/components/learn/LearnPracticePage.tsx";

function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

const scopeOf = (exercise) => ({
  exerciseId: exercise.id,
  skillId: exercise.skillId,
  difficulty: exercise.difficulty,
});

/** Play one authored solution on a fresh session and return the result. */
function playLine(exercise, line) {
  let session = createPracticeSession(exercise);
  let last = null;
  for (const move of line) {
    last = applyPracticeMove(session, move);
    session = last.session;
  }
  return { session, last };
}

const UI_KEYS = [
  "kicker",
  "title",
  "description",
  "setupKicker",
  "setupTitle",
  "categoryLabel",
  "skillLabel",
  "difficultyLabel",
  "start",
  "exerciseCount",
  "exerciseCountOne",
  "noExercises",
  "objective",
  "skillFocus",
  "difficultyReason",
  "hint",
  "nextHint",
  "noMoreHints",
  "checkedMove",
  "checkedMoveNote",
  "restart",
  "feedbackCorrect",
  "feedbackComplete",
  "feedbackOffGoal",
  "feedbackIllegal",
  "completeTitle",
  "completeLead",
  "movesUsed",
  "hintsUsed",
  "another",
  "backToSetup",
  "progressTitle",
  "progressEmpty",
  "attempted",
  "completed",
  "successRate",
  "hintTotal",
  "exercisesDone",
  "categoryProgress",
  "guestNote",
  "accountNote",
  "separateNote",
  "boardAria",
  "setupAria",
  "completeAria",
];

// ── Catalog validation ────────────────────────────────────────────────────

test("every published exercise passes the lesson validator", () => {
  assert.equal(VALIDATED_PRACTICE_EXERCISES.length, 18);
  for (const exercise of VALIDATED_PRACTICE_EXERCISES) {
    const result = validateLessonDefinition(practiceExerciseLesson(exercise));
    assert.equal(result.ok, true, `${exercise.id}: ${JSON.stringify(result.errors ?? [])}`);
    assert.equal(findPracticeExercise(exercise.id)?.id, exercise.id);
  }
});

test("every exercise has an authored solution that completes it", () => {
  for (const exercise of VALIDATED_PRACTICE_EXERCISES) {
    assert.ok(exercise.solutions.length >= 1, exercise.id);
    for (const line of exercise.solutions) {
      const { session } = playLine(exercise, line);
      assert.equal(session.completed, true, `${exercise.id} line did not complete`);
      assert.equal(session.log.length, line.length, exercise.id);
    }
  }
});

test("no exercise is already solved on its opening board", () => {
  for (const exercise of VALIDATED_PRACTICE_EXERCISES) {
    const session = createPracticeSession(exercise);
    assert.equal(session.completed, false, exercise.id);
    assert.equal(session.stepIndex, 0, exercise.id);
    assert.equal(session.log.length, 0, exercise.id);
    for (const step of exercise.steps) {
      assert.equal(step.done(session.state), false, `${exercise.id}/${step.id}`);
    }
  }
});

test("every exercise is a complete, unique 52-card deck", () => {
  for (const exercise of VALIDATED_PRACTICE_EXERCISES) {
    const tableau = exercise.deal.tableau.flat().map((slot) => slot.card);
    const cards = [...tableau, ...exercise.deal.stock];
    assert.equal(cards.length, 52, exercise.id);
    const unique = new Set(cards.map((card) => `${card.suit}-${card.rank}`));
    assert.equal(unique.size, 52, exercise.id);
    assert.equal(exercise.deal.tableau.length, 7, exercise.id);
    assert.equal(viewForState(createPracticeSession(exercise).state).tableau.length, 7);
  }
});

test("exercise ids, skills and categories agree", () => {
  const ids = new Set();
  for (const exercise of VALIDATED_PRACTICE_EXERCISES) {
    assert.equal(ids.has(exercise.id), false, exercise.id);
    ids.add(exercise.id);
    const skill = PRACTICE_SKILLS.find((entry) => entry.id === exercise.skillId);
    assert.ok(skill, exercise.skillId);
    assert.equal(exercise.categoryId, skill.categoryId, exercise.id);
    assert.ok(PRACTICE_DIFFICULTIES.includes(exercise.difficulty), exercise.id);
    assert.ok(exercise.rationaleKey.startsWith("learn.practice.exercises."), exercise.id);
  }
  assert.equal(new Set(PRACTICE_SKILLS.map((skill) => skill.id)).size, PRACTICE_SKILLS.length);
});

test("only skill areas with validated exercises are exposed", () => {
  const categories = practiceCategories();
  assert.deepEqual(
    categories.map((category) => category.id),
    ["tableau", "foundations", "stock-and-waste", "strategy"],
  );
  for (const category of categories) {
    assert.ok(practiceCategoryCount(category.id) > 0, category.id);
    const skills = practiceSkillsForCategory(category.id);
    assert.ok(skills.length > 0, category.id);
    for (const skill of skills) {
      assert.equal(skill.categoryId, category.id);
      assert.ok(practiceExerciseCount(skill.id) > 0, skill.id);
    }
  }
  assert.equal(PRACTICE_CATEGORIES.length, 4);
  assert.equal(PRACTICE_SKILLS.length, 16);
});

// ── Category and difficulty selection ─────────────────────────────────────

test("category selection returns only that category's skills", () => {
  for (const category of practiceCategories()) {
    for (const skill of practiceSkillsForCategory(category.id)) {
      assert.equal(skill.categoryId, category.id);
    }
  }
  const tableau = practiceSkillsForCategory("tableau").map((skill) => skill.id);
  assert.deepEqual(tableau, [
    "alternating-colors",
    "descending-sequences",
    "moving-runs",
    "reveal-hidden-cards",
    "opening-empty-columns",
    "managing-kings",
  ]);
  assert.deepEqual(
    practiceSkillsForCategory("stock-and-waste").map((skill) => skill.id),
    ["stock-draw-decisions", "waste-pile-management", "stock-cycle-planning"],
  );
});

test("difficulty selection only offers levels that have exercises", () => {
  assert.deepEqual(practiceDifficultiesFor("moving-runs"), ["intermediate", "advanced"]);
  assert.deepEqual(practiceDifficultiesFor("alternating-colors"), ["beginner", "intermediate"]);
  assert.deepEqual(practiceDifficultiesFor("managing-kings"), ["advanced"]);
  assert.equal(practiceExerciseCount("moving-runs", "beginner"), 0);
  assert.deepEqual(
    practiceExercisesFor("moving-runs", "advanced").map((exercise) => exercise.id),
    ["moving-runs-two"],
  );
  for (const level of practiceDifficultiesFor("moving-runs")) {
    assert.ok(practiceExerciseCount("moving-runs", level) >= 1, level);
  }
});

test("available counts come from validated exercises only", () => {
  const summary = practiceCatalogSummary();
  assert.equal(summary.total, VALIDATED_PRACTICE_EXERCISES.length);
  assert.deepEqual(summary.byDifficulty, {
    beginner: 5,
    intermediate: 7,
    advanced: 6,
  });
  const categoryTotal = practiceCategories().reduce(
    (total, category) => total + practiceCategoryCount(category.id),
    0,
  );
  assert.equal(categoryTotal, summary.total);
  const skillTotal = PRACTICE_SKILLS.reduce(
    (total, skill) => total + practiceExerciseCount(skill.id),
    0,
  );
  assert.equal(skillTotal, summary.total);
});

test("difficulty is authored reasoning complexity, not card count", () => {
  for (const exercise of VALIDATED_PRACTICE_EXERCISES) {
    const shortest = Math.min(...exercise.solutions.map((line) => line.length));
    if (exercise.difficulty === "beginner") {
      assert.ok(shortest <= 2, `${exercise.id} beginner but ${shortest} moves`);
    }
    if (exercise.difficulty === "advanced") {
      assert.ok(shortest >= 2, `${exercise.id} advanced but only ${shortest} move`);
    }
    assert.equal(typeof exercise.rationaleKey, "string");
  }
});

// ── Initialization and move validation ────────────────────────────────────

test("a session is built from a fresh, independent board", () => {
  const exercise = findPracticeExercise("alternating-colors");
  const first = createPracticeSession(exercise);
  const second = createPracticeSession(exercise);
  const move = exercise.solutions[0][0];
  const result = applyPracticeMove(first, move);

  assert.equal(result.accepted, true);
  assert.equal(first.log.length, 0, "the input session must not be mutated");
  assert.equal(result.session.log.length, 1);
  assert.equal(second.log.length, 0);
  assert.notEqual(result.session.state, first.state);
});

test("the rules engine refuses an illegal tableau placement", () => {
  const exercise = findPracticeExercise("alternating-colors");
  const session = createPracticeSession(exercise);
  // The club 7 (column 2) shares a colour with the spade 8, so it is illegal.
  const result = applyPracticeMove(session, {
    kind: "tableau-to-tableau",
    fromColumn: 2,
    card: { suit: "clubs", rank: 7 },
    toColumn: 0,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.feedback.kind, "incorrect");
  assert.equal(result.feedback.reason, "illegal");
  assert.equal(result.session.log.length, 0);
  assert.equal(result.session.state.ply, 0);
});

test("a malformed move never reaches the board", () => {
  const session = createPracticeSession(findPracticeExercise("moving-runs"));
  for (const move of [null, {}, { kind: "teleport" }, { kind: "tableau-to-tableau" }]) {
    const result = applyPracticeMove(session, move);
    assert.equal(result.accepted, false);
    assert.equal(result.session.log.length, 0);
  }
});

test("a legal but off-goal move is accepted without completing the drill", () => {
  const exercise = findPracticeExercise("foundation-timing");
  const session = createPracticeSession(exercise);
  const result = applyPracticeMove(session, { kind: "draw" });
  assert.equal(result.accepted, true);
  assert.equal(result.advanced, false);
  assert.equal(result.feedback.kind, "incorrect");
  assert.equal(result.feedback.reason, "off-goal");
  assert.equal(result.session.completed, false);
  assert.equal(result.session.log.length, 1);
});

test("completion reports the exercise's own success copy", () => {
  const exercise = findPracticeExercise("keeping-tableau-cards");
  const { session, last } = playLine(exercise, exercise.solutions[0]);
  assert.equal(last.feedback.kind, "complete");
  assert.equal(last.feedback.successKey, exercise.successKey);
  assert.equal(session.completed, true);
  assert.equal(session.completedAtPly, session.log.length);
});

test("an order-independent drill accepts both authored orders", () => {
  const exercise = findPracticeExercise("comparing-alternative-moves");
  assert.equal(exercise.solutions.length, 2);
  for (const line of exercise.solutions) {
    const { session } = playLine(exercise, line);
    assert.equal(session.completed, true);
  }
});

test("the checked-move helper follows a proven line and stops at the end", () => {
  const exercise = findPracticeExercise("opening-empty-columns");
  let session = createPracticeSession(exercise);
  const first = practiceSolutionMove(exercise, session);
  assert.ok(first);
  const applied = applyPracticeMove(session, first);
  assert.equal(applied.accepted, true);
  session = applied.session;
  const second = practiceSolutionMove(exercise, session);
  assert.ok(second);
  session = applyPracticeMove(session, second).session;
  assert.equal(session.completed, true);
  assert.equal(practiceSolutionMove(exercise, session), null);
});

// ── Hints ─────────────────────────────────────────────────────────────────

test("hints are progressive, counted, and never reveal a move first", () => {
  const exercise = findPracticeExercise("managing-kings");
  let session = createPracticeSession(exercise);

  const first = requestPracticeHint(session);
  assert.equal(first.hint.level, 1);
  assert.equal(first.hint.maxLevel, 2);
  assert.equal(first.hint.textKey, `learn.practice.skills.${exercise.skillId}.hint1`);
  assert.equal(first.hint.solutionMove, null, "the first hint must not name a move");
  session = first.session;

  const second = requestPracticeHint(session);
  assert.equal(second.hint.level, 2);
  assert.equal(second.hint.textKey, `learn.practice.skills.${exercise.skillId}.hint2`);
  session = second.session;

  const third = requestPracticeHint(session);
  assert.equal(third.hint, null);
  assert.equal(third.messageKey, "learn.feedback.noMoreHints");
  assert.equal(session.hintsUsed, 2);
});

test("every drill exposes a legal checked move at its start", () => {
  for (const exercise of VALIDATED_PRACTICE_EXERCISES) {
    const session = createPracticeSession(exercise);
    const move = practiceSolutionMove(exercise, session);
    assert.ok(move, exercise.id);
    const result = applyPracticeMove(session, move);
    assert.equal(result.accepted, true, exercise.id);
  }
});

// ── Restart, undo and next exercise ───────────────────────────────────────

test("restart rebuilds the opening position and clears the drill's hints", () => {
  const exercise = findPracticeExercise("planning-ahead");
  let session = createPracticeSession(exercise);
  session = applyPracticeMove(session, exercise.solutions[0][0]).session;
  session = requestPracticeHint(session).session;
  assert.equal(session.log.length, 1);
  assert.equal(session.hintsUsed, 1);

  const restarted = restartPractice(session);
  assert.equal(restarted.log.length, 0);
  assert.equal(restarted.stepIndex, 0);
  assert.equal(restarted.completed, false);
  assert.equal(restarted.hintsUsed, 0);
  assert.deepEqual(restarted.state.tableau, createPracticeSession(exercise).state.tableau);
});

test("undo replays the canonical log", () => {
  const exercise = findPracticeExercise("avoiding-blocked-positions");
  const opening = createPracticeSession(exercise);
  const played = applyPracticeMove(opening, exercise.solutions[0][0]).session;
  const undone = undoPracticeMove(played);
  assert.equal(undone.log.length, 0);
  assert.equal(undone.stepIndex, 0);
  assert.deepEqual(undone.state.tableau, opening.state.tableau);
  assert.deepEqual(undone.state.foundations, opening.state.foundations);
});

test("the next-exercise rotation is deterministic and repeatable", () => {
  assert.equal(nextPracticeExercise("alternating-colors", "beginner")?.id, "descending-sequences");
  assert.equal(
    nextPracticeExercise("stock-draw-decisions", "beginner")?.id,
    "alternating-colors",
  );
  assert.equal(nextPracticeExercise("managing-kings", "advanced")?.id, "keeping-tableau-cards");
  assert.equal(
    nextPracticeExercise("comparing-alternative-moves", "advanced")?.id,
    "moving-runs-two",
  );

  const pool = practiceCatalogSummary().byDifficulty.advanced;
  let cursor = "moving-runs-two";
  for (let step = 0; step < pool; step += 1) {
    cursor = nextPracticeExercise(cursor, "advanced")?.id ?? "";
  }
  assert.equal(cursor, "moving-runs-two", "the rotation must come back to the start");

  // A drill is explicitly repeatable.
  const exercise = findPracticeExercise("moving-runs-two");
  assert.equal(createPracticeSession(exercise).log.length, 0);
});

// ── Progress ──────────────────────────────────────────────────────────────

test("attempts, completions, hints and success rate accumulate", () => {
  const alternating = findPracticeExercise("alternating-colors");
  const runs = findPracticeExercise("moving-runs");

  let progress = emptyPracticeProgress();
  progress = recordPracticeAttempt(progress, scopeOf(alternating), 1);
  progress = recordPracticeAttempt(progress, scopeOf(alternating), 2);
  progress = recordPracticeHint(progress, scopeOf(alternating), 3);
  progress = recordPracticeCompletion(progress, scopeOf(alternating), 4);
  progress = recordPracticeAttempt(progress, scopeOf(runs), 5);

  const stats = practiceStats(progress);
  assert.equal(stats.attempts, 3);
  assert.equal(stats.completions, 1);
  assert.equal(stats.successRate, 33);
  assert.equal(stats.hints, 1);
  assert.equal(stats.exercisesAttempted, 2);
  assert.equal(stats.exercisesCompleted, 1);
  assert.deepEqual(stats.byDifficulty.beginner, {
    attempts: 2,
    completions: 1,
    hints: 1,
  });
  assert.deepEqual(stats.byDifficulty.intermediate, {
    attempts: 1,
    completions: 0,
    hints: 0,
  });
  assert.deepEqual(stats.byCategory.tableau, {
    attempts: 3,
    completions: 1,
    hints: 1,
  });
  assert.equal(progress.lastExerciseId, "moving-runs");
});

test("a scope that disagrees with the catalog is ignored", () => {
  const progress = emptyPracticeProgress();
  const mismatched = recordPracticeAttempt(progress, {
    exerciseId: "alternating-colors",
    skillId: "moving-runs",
    difficulty: "beginner",
  });
  assert.equal(mismatched, progress);
  const unknown = recordPracticeCompletion(progress, {
    exerciseId: "not-a-drill",
    skillId: "alternating-colors",
    difficulty: "beginner",
  });
  assert.equal(unknown, progress);
});

test("guest and account progress use separate local records", () => {
  assert.notEqual(
    practiceProgressStorageKey(null),
    practiceProgressStorageKey("user_123"),
  );
  assert.notEqual(
    practiceProgressStorageKey(null),
    LESSON_PROGRESS_STORAGE_PREFIX + ":guest",
    "practice must not reuse the lesson progress key",
  );

  const storage = fakeStorage();
  let guest = emptyPracticeProgress();
  guest = recordPracticeAttempt(guest, scopeOf(findPracticeExercise("foundation-timing")));
  writePracticeProgress(storage, null, guest);

  assert.equal(readPracticeProgress(storage, null).attempts, 1);
  assert.equal(readPracticeProgress(storage, "user_123").attempts, 0);

  let account = emptyPracticeProgress();
  account = recordPracticeCompletion(
    account,
    scopeOf(findPracticeExercise("efficient-foundations")),
  );
  writePracticeProgress(storage, "user_123", account);
  assert.equal(readPracticeProgress(storage, "user_123").completions, 1);
  assert.equal(readPracticeProgress(storage, null).completions, 0);
});

test("stale or malformed stored progress is pruned", () => {
  const normalized = normalizePracticeProgress({
    attempts: -3,
    completions: 2.8,
    hints: "many",
    byExercise: {
      "alternating-colors": { attempts: 2, completions: 1, hints: 0 },
      "retired-drill": { attempts: 9, completions: 9, hints: 9 },
    },
    bySkill: {
      "alternating-colors": { attempts: 2, completions: 1, hints: 0 },
      "retired-skill": { attempts: 9, completions: 9, hints: 9 },
    },
    byDifficulty: {
      beginner: { attempts: 2, completions: 1, hints: 0 },
      expert: { attempts: 9, completions: 9, hints: 9 },
    },
    lastExerciseId: "retired-drill",
    updatedAt: 12.9,
  });

  assert.equal(normalized.attempts, 0);
  assert.equal(normalized.completions, 2);
  assert.equal(normalized.hints, 0);
  assert.deepEqual(Object.keys(normalized.byExercise), ["alternating-colors"]);
  assert.deepEqual(Object.keys(normalized.bySkill), ["alternating-colors"]);
  assert.equal(normalized.byDifficulty.beginner.attempts, 2);
  assert.equal(normalized.byDifficulty.advanced.attempts, 0);
  assert.equal(normalized.lastExerciseId, null);
  assert.equal(normalized.updatedAt, 12);
  assert.deepEqual(normalizePracticeProgress("nonsense"), emptyPracticeProgress());
});

test("practice modules are isolated from every competitive record", () => {
  for (const file of [PRACTICE_SOURCE, PROGRESS_SOURCE, HOOK_SOURCE, PAGE_SOURCE]) {
    const source = read(file);
    assert.doesNotMatch(source, /\bfetch\s*\(/, file);
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*(serverStore|trophy|elo|rating|leaderboard|db\/|api\/)/,
      file,
    );
    assert.doesNotMatch(source, /localMatch/, file);
  }
  assert.match(read(PROGRESS_SOURCE), /PRACTICE_PROGRESS_STORAGE_PREFIX/);
});

// ── UI composition ────────────────────────────────────────────────────────

test("Practice renders the shared board and drives the shared engine", () => {
  const source = read(PAGE_SOURCE);
  assert.match(source, /LearnSubnav active="practice"/);
  assert.match(source, /<SolitaireBoard/);
  assert.match(source, /viewForState/);
  assert.match(source, /createPracticeSession/);
  assert.match(source, /applyPracticeMove/);
  assert.match(source, /requestPracticeHint/);
  assert.match(source, /restartPractice/);
  assert.match(source, /practiceSolutionMove/);
  assert.doesNotMatch(source, /from "\.\.\/solitaire-duel\/PlayingCard"/);
  assert.doesNotMatch(source, /Math\.random|shuffle/);

  for (const id of [
    "practice-start",
    "practice-hint",
    "practice-restart",
    "practice-another",
    "practice-return",
    "practice-progress",
    "practice-complete",
  ]) {
    assert.match(source, new RegExp(`data-testid="${id}"`), id);
  }
  // The selectable chips forward their test id through the shared Chip.
  for (const id of ["practice-category", "practice-skill", "practice-difficulty"]) {
    assert.match(source, new RegExp(`testId="${id}"`), id);
  }
});

test("Practice offers guest and account progress copy", () => {
  const source = read(PAGE_SOURCE);
  assert.match(source, /usePracticeProgress/);
  assert.match(source, /learn\.practice\.guestNote/);
  assert.match(source, /learn\.practice\.accountNote/);
  assert.match(source, /learn\.practice\.separateNote/);
});

test("no unvalidated random deal can enter the catalog", () => {
  const source = read(PRACTICE_SOURCE);
  assert.doesNotMatch(source, /Math\.random|shuffle|dealFromSeed|solvableDealFromSeed/);
  assert.match(source, /validateLessonDefinition/);
  assert.match(source, /solutionCompletesExercise/);
  const first = findPracticeExercise("alternating-colors").deal;
  assert.equal(findPracticeExercise("alternating-colors").deal, first, "deals are authored data");
});

// ── Localization ──────────────────────────────────────────────────────────

function localizedPracticeKeys() {
  const keys = [];
  for (const category of PRACTICE_CATEGORIES) {
    keys.push(category.titleKey, category.descriptionKey);
  }
  for (const skill of PRACTICE_SKILLS) {
    keys.push(skill.titleKey, skill.focusKey, ...skill.hintKeys);
  }
  for (const exercise of VALIDATED_PRACTICE_EXERCISES) {
    keys.push(
      exercise.titleKey,
      exercise.objectiveKey,
      exercise.explanationKey,
      exercise.successKey,
      exercise.rationaleKey,
    );
    for (const step of exercise.steps) {
      keys.push(step.instructionKey, step.explanationKey);
      if (step.incorrectKey) keys.push(step.incorrectKey);
      for (const hint of step.hints ?? []) keys.push(hint.textKey);
    }
  }
  for (const key of UI_KEYS) keys.push(`learn.practice.${key}`);
  for (const level of PRACTICE_DIFFICULTIES) {
    keys.push(
      `learn.practice.difficulty.${level}.label`,
      `learn.practice.difficulty.${level}.description`,
    );
  }
  return [...new Set(keys)];
}

test("every practice string exists in English, French and Spanish", () => {
  const keys = localizedPracticeKeys();
  assert.ok(keys.length > 150, `expected a substantial bundle, got ${keys.length}`);
  for (const language of ["en", "fr", "es"]) {
    for (const key of keys) {
      const value = resolvePractice(language, key);
      assert.equal(typeof value, "string", `${language} missing ${key}`);
      assert.ok(value.trim().length > 0, `${language} empty ${key}`);
    }
  }
});

test("French and Spanish are genuinely translated, not copied English", () => {
  const keys = localizedPracticeKeys();
  const english = keys.map((key) => resolvePractice("en", key));
  for (const language of ["fr", "es"]) {
    let translated = 0;
    keys.forEach((key, index) => {
      if (resolvePractice(language, key) !== english[index]) translated += 1;
    });
    assert.ok(translated > 120, `${language} only ${translated} strings differ from English`);
  }
});

test("the practice bundle is mounted in all three locales", () => {
  for (const language of ["en", "fr", "es"]) {
    assert.equal(APP_TEXT_TRANSLATIONS[language].learn.practice, LEARN_PRACTICE_TRANSLATIONS[language]);
  }
});

test("no hint claims a move is objectively best", () => {
  const keys = localizedPracticeKeys();
  const claims = /objectively optimal|\bbest move\b|meilleur coup|mejor jugada|jugada óptima/i;
  for (const language of ["en", "fr", "es"]) {
    for (const key of keys) {
      const value = resolvePractice(language, key);
      assert.doesNotMatch(String(value), claims, `${language} ${key}`);
    }
  }
});
