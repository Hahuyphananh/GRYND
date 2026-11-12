// tests/solitaire-lessons.test.mjs
//
// THE INTERACTIVE LESSON ENGINE AND THE FULL CURRICULUM.
//
// Every authored lesson is checked end-to-end through the REAL rules engine:
// prepared deals are complete unique decks, every step starts unmet, every
// canonical solution is legal and completes, and every reachable hint resolves.
//
// Run: node --experimental-test-module-mocks --import tsx --test tests/solitaire-lessons.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  applyLessonMove,
  createLessonSession,
  lessonProgress,
  requestLessonHint,
  restartLesson,
  undoLessonMove,
  validateLessonCatalog,
  validateLessonDefinition,
} from "../src/lib/solitaire-duel/lessons.ts";
import {
  LESSON_BY_ID,
  LESSON_CATALOG,
  LESSON_COURSES,
  lessonById,
  lessonsForCourse,
  nextLessonInCourse,
} from "../src/lib/solitaire-duel/lessonCatalog.ts";
import { initialStateFromDeal } from "../src/lib/solitaire-duel/rules.ts";

const LESSON_SOURCE = "src/lib/solitaire-duel/lessons.ts";
const read = (relPath) => fs.readFileSync(relPath, "utf8").replace(/\r\n/g, "\n");
const code = (relPath) =>
  read(relPath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const C = (suit, rank) => ({ suit, rank });
const H = (rank) => C("hearts", rank);
const D = (rank) => C("diamonds", rank);
const S = (rank) => C("spades", rank);
const CLUBS = (rank) => C("clubs", rank);
const t2t = (fromColumn, card, toColumn) => ({
  kind: "tableau-to-tableau",
  fromColumn,
  card,
  toColumn,
});
const t2f = (fromColumn, card, suit) => ({
  kind: "tableau-to-foundation",
  fromColumn,
  card,
  suit,
});

/** The intended line for every lesson. These are played, never merely listed. */
const SOLUTIONS = {
  "tableau-basics": [t2t(2, CLUBS(9), 0)],
  "first-draw": [
    { kind: "draw" },
    t2f(0, H(1), "hearts"),
    { kind: "waste-to-foundation", suit: "hearts" },
  ],
  "building-foundations": [t2f(0, D(1), "diamonds"), t2f(1, D(2), "diamonds")],
  "legal-moves": [t2t(0, H(7), 1), t2f(2, CLUBS(1), "clubs")],
  "alternating-colors": [t2t(0, H(7), 1), t2t(3, CLUBS(6), 1)],
  "descending-sequences": [t2t(0, D(9), 1), t2t(2, CLUBS(8), 1)],
  "moving-runs": [t2t(0, D(9), 1), t2t(2, S(6), 1)],
  "reveal-a-card": [t2t(2, H(10), 3)],
  "opening-columns": [t2t(0, S(13), 6), t2t(1, H(12), 6)],
  "moving-kings": [t2t(0, D(13), 6), t2f(0, S(1), "spades")],
  "choosing-sequences": [t2t(0, H(8), 1), t2t(0, CLUBS(9), 4)],
  "blocked-columns": [t2t(0, S(7), 1), t2t(0, D(6), 2)],
  "foundation-timing": [t2f(0, S(1), "spades"), t2t(0, D(9), 1)],
  "keeping-tableau-cards": [
    t2f(2, CLUBS(1), "clubs"),
    t2f(1, CLUBS(2), "clubs"),
    t2t(3, D(2), 0),
  ],
  "low-value-cards": [
    t2f(1, D(1), "diamonds"),
    t2t(2, CLUBS(3), 3),
    t2f(0, D(2), "diamonds"),
  ],
  "efficient-foundations": [
    t2f(0, CLUBS(1), "clubs"),
    t2f(1, CLUBS(2), "clubs"),
    t2f(2, CLUBS(3), "clubs"),
  ],
  "planning-ahead": [
    t2t(0, H(9), 1),
    t2t(2, CLUBS(8), 1),
    t2t(3, D(7), 1),
  ],
  "choosing-reveals": [t2t(0, S(10), 2), t2t(0, D(9), 2)],
  "stock-cycles": [
    { kind: "draw" },
    { kind: "draw" },
    { kind: "draw" },
    { kind: "draw" },
  ],
  "difficult-positions": [t2t(0, H(9), 1), t2t(0, S(8), 1)],
};

const cardKeys = (lesson) => [
  ...lesson.deal.tableau.flatMap((column) => column.map((slot) => slot.card)),
  ...lesson.deal.stock,
].map((card) => `${card.suit}-${card.rank}`);

// ── 1. Curriculum integrity ───────────────────────────────────────────────

test("the catalog contains five courses with four ordered lessons each", () => {
  const validation = validateLessonCatalog(LESSON_CATALOG);
  assert.equal(validation.ok, true, validation.ok ? "" : validation.errors.join("\n"));

  assert.equal(LESSON_CATALOG.length, 20);
  assert.equal(LESSON_COURSES.length, 5);
  assert.deepEqual(
    LESSON_COURSES.map((course) => course.id),
    [
      "board-basics",
      "moving-cards",
      "tableau-management",
      "foundation-strategy",
      "advanced-strategy",
    ],
  );

  const courseIds = new Set(LESSON_COURSES.map((course) => course.id));
  for (const course of LESSON_COURSES) {
    const lessons = lessonsForCourse(course.id);
    assert.equal(lessons.length, 4, `${course.id} must have four lessons`);
    assert.deepEqual(
      lessons.map((lesson) => lesson.order),
      [1, 2, 3, 4],
      `${course.id} lesson order`,
    );
    for (const lesson of lessons) {
      assert.equal(lesson.courseId, course.id);
      assert.equal(lessonById(lesson.id), lesson);
      assert.equal(courseIds.has(lesson.courseId), true);
    }
  }

  assert.equal(new Set(LESSON_CATALOG.map((lesson) => lesson.id)).size, 20);
});

test("every lesson is a complete unique deal and starts unmet", () => {
  for (const lesson of LESSON_CATALOG) {
    const keys = cardKeys(lesson);
    assert.equal(keys.length, 52, `${lesson.id} must hold a full deck`);
    assert.equal(new Set(keys).size, 52, `${lesson.id} must not repeat a card`);
    assert.equal(lesson.deal.tableau.length, 7, `${lesson.id} needs seven columns`);
    assert.ok(lesson.steps.length >= 1, `${lesson.id} needs an exercise`);

    const initial = initialStateFromDeal(lesson.deal);
    for (const step of lesson.steps) {
      assert.equal(step.done(initial), false, `${lesson.id}/${step.id} starts done`);
      assert.ok(step.hints?.length >= 1, `${lesson.id}/${step.id} needs a hint`);
    }
  }
});

test("courses expose the next lesson inside the course", () => {
  assert.equal(nextLessonInCourse("tableau-basics").id, "first-draw");
  assert.equal(nextLessonInCourse("legal-moves"), null);
  assert.equal(nextLessonInCourse("planning-ahead").id, "choosing-reveals");
  assert.equal(nextLessonInCourse("difficult-positions"), null);
  assert.equal(nextLessonInCourse("missing"), null);
});

// ── 2. Every authored solution is playable ────────────────────────────────

test("every canonical solution is legal, advances the plan and completes", () => {
  for (const lesson of LESSON_CATALOG) {
    const moves = SOLUTIONS[lesson.id];
    assert.ok(moves, `missing solution line for ${lesson.id}`);

    let session = createLessonSession(lesson);
    for (const [index, move] of moves.entries()) {
      const result = applyLessonMove(session, move);
      assert.equal(result.accepted, true, `${lesson.id} move ${index + 1} was refused`);
      assert.equal(result.advanced, true, `${lesson.id} move ${index + 1} did not advance`);
      session = result.session;
    }

    assert.equal(session.completed, true, `${lesson.id} did not complete`);
    assert.deepEqual(
      session.completedStepIds,
      lesson.steps.map((step) => step.id),
      `${lesson.id} completed the wrong steps`,
    );
    assert.equal(lessonProgress(session).completed, true);
  }
});

test("every reachable hint resolves and every solution hint is legal", () => {
  for (const lesson of LESSON_CATALOG) {
    const moves = SOLUTIONS[lesson.id];

    for (let stepIndex = 0; stepIndex < lesson.steps.length; stepIndex += 1) {
      let session = createLessonSession(lesson);
      for (const move of moves) {
        if (session.stepIndex >= stepIndex) break;
        session = applyLessonMove(session, move).session;
      }
      // A cascading move can satisfy more than one step; the later hints are
      // intentionally unreachable because the lesson has already advanced.
      if (session.stepIndex !== stepIndex) continue;

      const step = lesson.steps[stepIndex];
      let hinted = session;
      for (let hintIndex = 0; hintIndex < step.hints.length; hintIndex += 1) {
        const result = requestLessonHint(hinted);
        assert.ok(result.hint, `${lesson.id}/${step.id} missing hint ${hintIndex + 1}`);
        assert.equal(result.hint.textKey, step.hints[hintIndex].textKey);
        assert.equal(result.hint.level, hintIndex + 1);
        assert.equal(result.hint.maxLevel, step.hints.length);

        if (hintIndex === 0) {
          assert.equal(result.hint.solutionMove, null, "first hint must not spoil the move");
        }
        if (result.hint.solutionMove) {
          const applied = applyLessonMove(hinted, result.hint.solutionMove);
          assert.equal(applied.accepted, true, `${lesson.id}/${step.id} hint move refused`);
          assert.equal(applied.advanced, true, `${lesson.id}/${step.id} hint move stalled`);
        }
        hinted = result.session;
      }

      const exhausted = requestLessonHint(hinted);
      assert.equal(exhausted.hint, null);
      assert.equal(exhausted.messageKey, "learn.feedback.noMoreHints");
    }
  }
});

// ── 3. Engine behaviour used by the curriculum ────────────────────────────

test("a lesson can accept either of two legal targets", () => {
  const lesson = LESSON_BY_ID["tableau-basics"];
  const viaHearts = applyLessonMove(
    createLessonSession(lesson),
    t2t(2, CLUBS(9), 0),
  );
  const viaDiamonds = applyLessonMove(
    createLessonSession(lesson),
    t2t(2, CLUBS(9), 1),
  );

  for (const result of [viaHearts, viaDiamonds]) {
    assert.equal(result.accepted, true);
    assert.equal(result.advanced, true);
    assert.equal(result.session.completed, true);
  }
});

test("legal off-goal moves are accepted but never scored", () => {
  const lesson = LESSON_BY_ID["first-draw"];
  const drawn = applyLessonMove(createLessonSession(lesson), { kind: "draw" });
  assert.equal(drawn.session.stepIndex, 1);

  const secondDraw = applyLessonMove(drawn.session, { kind: "draw" });
  assert.equal(secondDraw.accepted, true);
  assert.equal(secondDraw.advanced, false);
  assert.equal(secondDraw.feedback.kind, "incorrect");
  assert.equal(secondDraw.feedback.reason, "off-goal");
  assert.equal(secondDraw.session.stepIndex, 1);
});

test("illegal moves are refused without changing the board", () => {
  const lesson = LESSON_BY_ID["legal-moves"];
  const session = createLessonSession(lesson);
  const before = JSON.stringify(session.state);

  const result = applyLessonMove(session, {
    kind: "tableau-to-foundation",
    fromColumn: 0,
    card: H(7),
    suit: "hearts",
  });

  assert.equal(result.accepted, false);
  assert.equal(result.feedback.kind, "incorrect");
  assert.equal(result.feedback.reason, "illegal");
  assert.equal(JSON.stringify(result.session.state), before);
  assert.equal(session.attempts, 0);
});

test("one real move can complete two ordered steps by cascade", () => {
  const lesson = LESSON_BY_ID["reveal-a-card"];
  const result = applyLessonMove(createLessonSession(lesson), t2t(2, H(10), 3));

  assert.equal(result.feedback.kind, "complete");
  assert.deepEqual(result.session.completedStepIds, ["place", "expose"]);
  assert.equal(result.session.completed, true);
  assert.deepEqual(result.session.state.tableau[2], [
    { card: CLUBS(9), faceUp: true },
  ]);
});

test("hints are progressive and reset with the step", () => {
  const lesson = LESSON_BY_ID["first-draw"];
  let session = createLessonSession(lesson);

  const first = requestLessonHint(session);
  assert.equal(first.hint.solutionMove, null);
  assert.equal(first.session.hintsUsed, 1);

  const second = requestLessonHint(first.session);
  assert.deepEqual(second.hint.solutionMove, { kind: "draw" });
  assert.equal(second.session.hintsUsed, 2);

  const drawn = applyLessonMove(second.session, { kind: "draw" });
  assert.equal(drawn.session.hintIndex, 0);
  assert.equal(drawn.session.hintsUsed, 2);
});

test("undo replays the log and restart resets the attempt", () => {
  const lesson = LESSON_BY_ID["first-draw"];
  let session = createLessonSession(lesson);
  session = applyLessonMove(session, { kind: "draw" }).session;
  session = applyLessonMove(session, t2f(0, H(1), "hearts")).session;
  assert.equal(session.stepIndex, 2);

  const undone = undoLessonMove(session);
  assert.equal(undone.stepIndex, 1);
  assert.equal(undone.state.foundations.hearts.length, 0);
  assert.equal(undone.log.length, 1);

  const restarted = restartLesson(session);
  assert.deepEqual(restarted.state, initialStateFromDeal(lesson.deal));
  assert.equal(restarted.log.length, 0);
  assert.equal(restarted.stepIndex, 0);
  assert.equal(restarted.hintsUsed, 0);
});

test("the engine has no competitive or browser side effects", () => {
  const source = code(LESSON_SOURCE);
  assert.match(source, /initialStateFromDeal/);
  assert.match(source, /applyMove\(/);
  assert.match(source, /normalizeMove/);
  assert.doesNotMatch(source, /function validateMove\(/);
  assert.doesNotMatch(
    source,
    /fetch\(|localStorage|sessionStorage|create-or-join|matchmaking|applyRating|\btroph|\bquest|\belo\b/i,
  );
  assert.doesNotMatch(source, /from\s+["'][^"']*(serverStore|room|realtime|bot|ranked)/i);
});

// ── 4. Invalid definitions ────────────────────────────────────────────────

test("invalid definitions and broken catalogs are rejected", () => {
  const first = LESSON_BY_ID["first-draw"];
  assert.equal(validateLessonDefinition({ ...first, steps: [] }).ok, false);
  assert.equal(
    validateLessonDefinition({ ...first, steps: [first.steps[0], first.steps[0]] }).ok,
    false,
  );
  assert.equal(
    validateLessonDefinition({ ...first, difficulty: "expert" }).ok,
    false,
  );
  assert.equal(
    validateLessonDefinition({ ...first, estimatedMinutes: 0 }).ok,
    false,
  );

  const duplicateIds = validateLessonCatalog([first, { ...first }]);
  assert.equal(duplicateIds.ok, false);
  assert.equal(validateLessonCatalog([]).ok, false);
  assert.throws(
    () => createLessonSession({ ...first, steps: [] }),
    /Invalid lesson definition/,
  );

  const duplicateCard = {
    ...first,
    deal: { ...first.deal, stock: [...first.deal.stock, H(1)] },
  };
  assert.equal(validateLessonDefinition(duplicateCard).ok, false);

  const sixColumns = {
    ...first,
    deal: { ...first.deal, tableau: first.deal.tableau.slice(0, 6) },
  };
  assert.equal(validateLessonDefinition(sixColumns).ok, false);
});
