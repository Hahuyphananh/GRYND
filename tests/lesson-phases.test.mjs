// tests/lesson-phases.test.mjs
//
// THE MULTI-PHASE LESSON CONTRACT.
//
// These tests exercise the pure phase machine and the real lesson/rules engine:
// optional phases, every transition, demonstration replay, practice completion,
// knowledge checks, persisted resume position, restart, and compatibility with
// the existing 20 lessons. The component assertions only verify composition:
// the views reuse SolitaireBoard and the engine rather than a fake board.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { LEARN_TRANSLATIONS } from "../src/lib/learnTranslations.js";
import {
  LESSON_CATALOG,
  lessonById,
} from "../src/lib/solitaire-duel/lessonCatalog.ts";
import {
  applyLessonMove,
  createLessonSession,
  validateLessonCatalog,
  validateLessonDefinition,
} from "../src/lib/solitaire-duel/lessons.ts";
import {
  checkKnowledgeAnswer,
  createDemoSession,
  createLessonPhaseState,
  currentLessonPhase,
  demoNext,
  demoReplay,
  isKnowledgeAnswerCorrect,
  isLastLessonPhase,
  lessonPhasePlan,
  nextLessonPhase,
  practiceLesson,
  previousLessonPhase,
  withPracticeIndex,
} from "../src/lib/solitaire-duel/lessonPhases.ts";
import {
  emptyLessonProgress,
  isLessonCompleted,
  lessonPhaseIndex,
  lessonProgressStorageKey,
  normalizeLessonProgress,
  readLessonProgress,
  recordLessonProgress,
  writeLessonProgress,
} from "../src/lib/solitaire-duel/lessonProgress.ts";

const ROOT = process.cwd();
const read = (relPath) =>
  fs.readFileSync(path.join(ROOT, relPath), "utf8").replace(/\r\n/g, "\n");
const resolve = (bundle, key) =>
  key.split(".").reduce((value, part) => value?.[part], bundle);

const base = lessonById("first-draw");
const phasesLesson = {
  ...base,
  phases: {
    learn: {
      titleKey: "learn.lessons.first-draw.step.draw.instruction",
      explanationKey: "learn.lessons.first-draw.step.draw.explanation",
      whyKey: "learn.lessons.first-draw.step.draw.incorrect",
    },
    watch: {
      deal: base.deal,
      steps: [
        {
          move: { kind: "draw" },
          explanationKey: "learn.lessons.first-draw.step.draw.explanation",
        },
      ],
    },
    practice: [
      {
        id: "practice-1",
        deal: base.deal,
        instructionKey: "learn.lessons.first-draw.step.draw.instruction",
        steps: base.steps,
        successKey: base.successKey,
      },
    ],
    knowledgeCheck: {
      questionKey: "learn.lessons.first-draw.step.draw.instruction",
      options: [
        { id: "a", textKey: "learn.lessons.first-draw.step.draw.explanation" },
        { id: "b", textKey: "learn.lessons.first-draw.success" },
      ],
      correctOptionId: "b",
      explanationKey: "learn.lessons.first-draw.step.draw.explanation",
    },
    recap: {
      summaryKey: "learn.lessons.first-draw.success",
      rememberKey: "learn.lessons.first-draw.step.draw.explanation",
      nextLessonId: "building-foundations",
    },
  },
};

const SOLUTION = [
  { kind: "draw" },
  {
    kind: "tableau-to-foundation",
    fromColumn: 0,
    card: { suit: "hearts", rank: 1 },
    suit: "hearts",
  },
  { kind: "waste-to-foundation", suit: "hearts" },
];

function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

test("optional phases are skipped when a lesson does not define them", () => {
  const optionalLesson = { ...base, phases: undefined };
  assert.deepEqual(lessonPhasePlan(optionalLesson), ["guided"]);
  assert.deepEqual(lessonPhasePlan(phasesLesson), [
    "learn",
    "watch",
    "guided",
    "practice",
    "knowledgeCheck",
    "recap",
  ]);
  assert.equal(createLessonPhaseState(optionalLesson).plan.length, 1);
});

test("every phase transition is explicit and bounded", () => {
  let state = createLessonPhaseState(phasesLesson);
  assert.equal(currentLessonPhase(state), "learn");
  assert.equal(state.index, 0);
  assert.equal(previousLessonPhase(state), null);

  const forward = [];
  while (true) {
    const next = nextLessonPhase(state);
    if (!next) break;
    assert.equal(next.index, state.index + 1);
    state = next;
    forward.push(currentLessonPhase(state));
  }

  assert.deepEqual(forward, ["watch", "guided", "practice", "knowledgeCheck", "recap"]);
  assert.equal(isLastLessonPhase(state), true);
  assert.equal(nextLessonPhase(state), null);

  const backward = [];
  while (true) {
    const previous = previousLessonPhase(state);
    if (!previous) break;
    state = previous;
    backward.push(currentLessonPhase(state));
  }
  assert.deepEqual(backward, ["knowledgeCheck", "practice", "guided", "watch", "learn"]);
  assert.equal(state.index, 0);
});

test("a persisted phase index is clamped to the lesson's real plan", () => {
  assert.equal(createLessonPhaseState(phasesLesson, 99).index, 5);
  assert.equal(createLessonPhaseState(phasesLesson, -3).index, 0);
  assert.equal(createLessonPhaseState(phasesLesson, 2.9).index, 2);
  const practice = withPracticeIndex(createLessonPhaseState(phasesLesson), 4);
  assert.equal(practice.practiceIndex, 4);
});

test("the demonstration runs on the real engine and can be replayed", () => {
  const watch = phasesLesson.phases.watch;
  const demo = createDemoSession(watch);
  assert.equal(demo.stepIndex, 0);
  assert.equal(currentLessonPhase(createLessonPhaseState(phasesLesson)), "learn");

  const applied = demoNext(demo);
  assert.equal(applied.ok, true);
  assert.equal(applied.session.stepIndex, 1);
  assert.notDeepEqual(applied.session.state, demo.state);
  assert.equal(demoNext(applied.session).ok, false);

  const replay = demoReplay(watch);
  assert.equal(replay.stepIndex, 0);
  assert.deepEqual(replay.state, demo.state);
});

test("practice positions complete through the same lesson engine", () => {
  const synthetic = practiceLesson(phasesLesson, 0);
  assert.ok(synthetic);
  assert.equal(synthetic.id, "first-draw:practice:practice-1");
  assert.equal(synthetic.phases, undefined);

  let session = createLessonSession(synthetic);
  for (const move of SOLUTION) {
    const result = applyLessonMove(session, move);
    assert.equal(result.accepted, true);
    session = result.session;
  }
  assert.equal(session.completed, true);
  assert.equal(practiceLesson(phasesLesson, 99), null);
});

test("knowledge checks validate only real option ids and the correct answer", () => {
  const check = phasesLesson.phases.knowledgeCheck;
  assert.equal(checkKnowledgeAnswer(check, "b")?.correct, true);
  assert.equal(checkKnowledgeAnswer(check, "a")?.correct, false);
  assert.equal(checkKnowledgeAnswer(check, "missing"), null);
  assert.equal(isKnowledgeAnswerCorrect(check, "b"), true);
  assert.equal(isKnowledgeAnswerCorrect(check, "a"), false);
});

test("phase definitions and demo moves are validated before use", () => {
  const valid = validateLessonDefinition(phasesLesson);
  assert.equal(valid.ok, true, valid.ok ? "" : valid.errors.join("\n"));

  const badAnswer = {
    ...phasesLesson,
    phases: {
      ...phasesLesson.phases,
      knowledgeCheck: {
        ...phasesLesson.phases.knowledgeCheck,
        correctOptionId: "not-an-option",
      },
    },
  };
  const badAnswerResult = validateLessonDefinition(badAnswer);
  assert.equal(badAnswerResult.ok, false);
  assert.ok(badAnswerResult.errors.some((error) => error.includes("correctOptionId")));

  const badDemo = {
    ...phasesLesson,
    phases: {
      ...phasesLesson.phases,
      watch: {
        deal: base.deal,
        steps: [
          {
            move: { kind: "foundation-to-tableau", suit: "hearts", toColumn: 0 },
            explanationKey: "learn.lessons.first-draw.step.draw.explanation",
          },
        ],
      },
    },
  };
  const badDemoResult = validateLessonDefinition(badDemo);
  assert.equal(badDemoResult.ok, false);
  assert.ok(badDemoResult.errors.some((error) => error.includes("illegal")));
});

test("progress persists a resume phase without erasing completion", () => {
  const id = phasesLesson.id;
  let progress = emptyLessonProgress();
  assert.deepEqual(progress.phaseIndexByLesson, {});

  progress = recordLessonProgress(progress, {
    lessonId: id,
    stepIndex: 1,
    phaseIndex: 3,
  });
  assert.equal(lessonPhaseIndex(progress, id), 3);
  assert.equal(isLessonCompleted(progress, id), false);

  progress = recordLessonProgress(progress, {
    lessonId: id,
    stepIndex: base.steps.length,
    completed: true,
  });
  assert.equal(isLessonCompleted(progress, id), true);
  assert.equal(lessonPhaseIndex(progress, id), 3, "completion keeps the phase");

  // Restart at the beginning of the first phase: history stays complete.
  progress = recordLessonProgress(progress, {
    lessonId: id,
    stepIndex: 0,
    phaseIndex: 0,
  });
  assert.equal(isLessonCompleted(progress, id), true);
  assert.equal(lessonPhaseIndex(progress, id), 0);
});

test("old progress payloads normalize to an empty phase map", () => {
  const id = phasesLesson.id;
  const normalized = normalizeLessonProgress({
    completedLessonIds: [id],
    stepIndexByLesson: { [id]: 2 },
    lastLessonId: id,
    updatedAt: 12,
  });
  assert.deepEqual(normalized.phaseIndexByLesson, {});
  assert.equal(isLessonCompleted(normalized, id), true);

  const withPhase = normalizeLessonProgress({
    ...normalized,
    phaseIndexByLesson: { [id]: 2.8, unknown: 4 },
  });
  assert.deepEqual(withPhase.phaseIndexByLesson, { [id]: 2 });
});

test("guests and signed-in players keep separate local progress", () => {
  const progress = recordLessonProgress(emptyLessonProgress(), {
    lessonId: phasesLesson.id,
    stepIndex: 1,
    phaseIndex: 2,
  });
  const storage = fakeStorage();
  assert.notEqual(lessonProgressStorageKey(null), lessonProgressStorageKey("user-a"));
  assert.match(lessonProgressStorageKey(null), /guest$/);
  writeLessonProgress(storage, null, progress);
  assert.equal(readLessonProgress(storage, null).phaseIndexByLesson[phasesLesson.id], 2);
  assert.equal(readLessonProgress(storage, "user-a").phaseIndexByLesson[phasesLesson.id], undefined);
  writeLessonProgress(storage, "user-a", progress);
  assert.equal(readLessonProgress(storage, "user-a").phaseIndexByLesson[phasesLesson.id], 2);
});

test("all 20 lessons now carry the expected teaching phases", () => {
  const validation = validateLessonCatalog(LESSON_CATALOG);
  assert.equal(validation.ok, true, validation.ok ? "" : validation.errors.join("\n"));
  assert.equal(LESSON_CATALOG.length, 20);

  for (const lesson of LESSON_CATALOG) {
    const plan = lessonPhasePlan(lesson);
    assert.equal(plan[0], "learn", lesson.id);
    assert.equal(plan[1], "watch", lesson.id);
    assert.ok(plan.includes("guided"), lesson.id);
    assert.equal(plan[plan.length - 1], "recap", lesson.id);
    assert.ok(lesson.phases?.learn, lesson.id);
    assert.ok(lesson.phases?.watch, lesson.id);
    assert.ok(lesson.phases?.knowledgeCheck, lesson.id);
    assert.ok(lesson.phases?.recap, lesson.id);
    assert.ok(lesson.estimatedMinutes >= 3 && lesson.estimatedMinutes <= 8, lesson.id);
    if (lesson.id === "tableau-basics" || lesson.id === "first-draw") {
      assert.equal(lesson.phases?.practice, undefined, lesson.id);
    } else {
      assert.ok(lesson.phases?.practice?.length, lesson.id);
    }
  }
});

test("every demonstration and practice exercise is actually completable", () => {
  let demonstrations = 0;
  let practices = 0;

  for (const lesson of LESSON_CATALOG) {
    const watch = lesson.phases.watch;
    assert.ok(watch.steps.length > 0, lesson.id);
    const demo = demoNext(createDemoSession(watch));
    assert.equal(demo.ok, true, lesson.id + " demonstration move");
    assert.equal(demo.session.stepIndex, watch.steps.length, lesson.id);
    demonstrations += 1;

    for (let index = 0; index < (lesson.phases.practice?.length ?? 0); index += 1) {
      const position = lesson.phases.practice[index];
      const synthetic = practiceLesson(lesson, index);
      assert.ok(synthetic, lesson.id + " practice " + index);
      assert.notEqual(position.deal, lesson.deal, lesson.id + " needs a fresh position");
      const move = position.steps[0].acceptableMoves?.[0];
      assert.ok(move, lesson.id + " practice has a canonical move");
      const result = applyLessonMove(createLessonSession(synthetic), move);
      assert.equal(result.accepted, true, lesson.id + " practice move accepted");
      assert.equal(result.advanced, true, lesson.id + " practice advanced");
      assert.equal(result.session.completed, true, lesson.id + " practice completed");
      practices += 1;
    }
  }

  assert.equal(demonstrations, 20);
  assert.equal(practices, 18);
});

test("every knowledge check has a valid answer and recap keys", () => {
  for (const lesson of LESSON_CATALOG) {
    const check = lesson.phases.knowledgeCheck;
    assert.ok(check.options.length >= 2, lesson.id);
    assert.ok(check.options.some((option) => option.id === check.correctOptionId), lesson.id);
    assert.equal(checkKnowledgeAnswer(check, check.correctOptionId)?.correct, true, lesson.id);
    const wrong = check.options.find((option) => option.id !== check.correctOptionId);
    assert.ok(wrong, lesson.id);
    assert.equal(checkKnowledgeAnswer(check, wrong.id)?.correct, false, lesson.id);
    assert.ok(lesson.phases.recap.summaryKey, lesson.id);
    assert.ok(lesson.phases.recap.rememberKey, lesson.id);
  }
});

test("the player composes the real phase views and guards transitions", () => {
  const player = read("src/components/learn/LessonPlayer.tsx");
  assert.match(player, /LessonPhaseViews/);
  assert.match(player, /PhaseRail/);
  assert.match(player, /createLessonPhaseState/);
  assert.match(player, /nextLessonPhase/);
  assert.match(player, /previousLessonPhase/);
  assert.match(player, /phaseLockRef/);
  assert.match(player, /recordPhase/);
  assert.match(player, /interactive=\{!pendingAdvance && !session\.completed\}/);
  assert.doesNotMatch(player, /setTimeout\(/);
});

test("demonstration and practice do not build a fake board", () => {
  const views = read("src/components/learn/LessonPhaseViews.tsx");
  assert.match(views, /SolitaireBoard/);
  assert.match(views, /viewForState\(demo\.state\)/);
  assert.match(views, /viewForState\(session\.state\)/);
  assert.match(views, /createDemoSession/);
  assert.match(views, /demoNext/);
  assert.match(views, /checkKnowledgeAnswer/);
  assert.doesNotMatch(views, /PlayingCard/);
});

test("every new phase string exists in EN, FR and ES with matching placeholders", () => {
  const keys = [
    "label",
    "progress",
    "continue",
    "back",
    "finish",
    "learn",
    "watch",
    "guided",
    "practice",
    "knowledgeCheck",
    "recap",
    "whyMatters",
    "concept",
    "watchLead",
    "nextAction",
    "replayDemo",
    "demoComplete",
    "demoProgress",
    "demoBoardAria",
    "practicePosition",
    "practiceComplete",
    "practiceNext",
    "practiceBoardAria",
    "practiceTryAgain",
    "chooseAnswer",
    "checkAnswer",
    "correct",
    "incorrect",
    "explanation",
    "question",
    "remember",
    "summary",
    "suggestedNext",
    "guidedComplete",
    "mistake",
    "recognize",
  ];
  const placeholders = (value) =>
    [...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

  let reference = null;
  for (const language of ["en", "fr", "es"]) {
    const values = keys.map((key) => {
      const value = resolve(LEARN_TRANSLATIONS[language], "player.phases." + key);
      assert.equal(typeof value, "string", language + " player.phases." + key);
      assert.ok(value.trim().length > 0, language + " player.phases." + key + " is empty");
      return value;
    });
    const shape = values.map(placeholders);
    if (!reference) reference = shape;
    else assert.deepEqual(shape, reference, language + " placeholder shape");
  }
});

test("every knowledge check and practice instruction is localized", () => {
  for (const language of ["en", "fr", "es"]) {
    const bundle = LEARN_TRANSLATIONS[language];
    assert.equal(typeof bundle.phases.practiceInstruction, "string", language);
    for (const lesson of LESSON_CATALOG) {
      for (const field of ["question", "correct", "wrong", "explanation"]) {
        const value = resolve(bundle, "phases.quiz." + lesson.id + "." + field);
        assert.equal(
          typeof value,
          "string",
          language + " quiz " + lesson.id + " " + field,
        );
        assert.ok(value.trim().length > 0, language + " quiz " + lesson.id + " " + field);
      }
    }
  }
});
