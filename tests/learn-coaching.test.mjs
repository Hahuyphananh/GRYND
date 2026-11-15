// tests/learn-coaching.test.mjs
//
// THE GRYND PRO ADVANCED COACHING CONTRACT.
//
// The engine is pure, so these tests drive it with real local practice records
// and fixed dates: empty history, insufficient data, a supported weak skill,
// a skill ready for a harder drill, a forged snapshot, a two-week comparison and
// the 30-day cap. The entitlement tests are source assertions on the API route
// because the gate is deliberately server-only: the route must resolve
// membership itself, before it reads the body, and the locked response must
// contain no analytics at all.
//
// Nothing here fabricates a weakness. A skill only becomes "weak" when the
// recorded attempts support it, and an empty record produces an empty coaching
// report rather than invented advice.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { APP_TEXT_TRANSLATIONS } from "../src/lib/appTextTranslations.js";
import { LEARN_TRANSLATIONS } from "../src/lib/learnTranslations.js";
import { LEARN_COACHING_TRANSLATIONS } from "../src/lib/learnCoachingTranslations.js";
import {
  COACHING_BENEFIT_KEYS,
  COACHING_THRESHOLDS,
  SKILL_LESSON_ID,
  buildCoachingReport,
  coachingSnapshotFromLocal,
  emptyCoachingSnapshot,
  sanitizeCoachingSnapshot,
} from "../src/lib/learn/coaching.ts";
import {
  PRACTICE_SKILLS,
  findPracticeExercise,
  practiceDifficultiesFor,
  practiceExercisesFor,
} from "../src/lib/solitaire-duel/practice.ts";
import {
  emptyPracticeProgress,
  normalizePracticeProgress,
  practiceDayKey,
  recordPracticeAttempt,
  recordPracticeCompletion,
  recordPracticeHint,
} from "../src/lib/solitaire-duel/practiceProgress.ts";
import {
  emptyLessonProgress,
  readLessonProgress,
  recordLessonProgress,
  writeLessonProgress,
} from "../src/lib/solitaire-duel/lessonProgress.ts";
import {
  LESSON_BY_ID,
  LESSON_CATALOG,
  LESSON_COURSES,
} from "../src/lib/solitaire-duel/lessonCatalog.ts";

const ROOT = process.cwd();
const read = (relative) =>
  fs.readFileSync(path.join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");

const ROUTE_SOURCE = "src/app/api/learn/coaching/route.ts";
const ENGINE_SOURCE = "src/lib/learn/coaching.ts";
const PAGE_SOURCE = "src/app/learn/coaching/page.tsx";
const CLIENT_SOURCE = "src/components/learn/LearnCoachingPage.tsx";
const PRACTICE_PAGE_SOURCE = "src/app/learn/practice/page.tsx";
const PRACTICE_SOURCE = "src/components/learn/LearnPracticePage.tsx";

const scopeOf = (exercise) => ({
  exerciseId: exercise.id,
  skillId: exercise.skillId,
  difficulty: exercise.difficulty,
});

/** Record a run of attempts/completions/hints on one drill. */
function progressFor(
  exercise,
  { attempts = 0, completions = 0, hints = 0 },
  start = Date.parse("2026-06-10T10:00:00Z"),
) {
  let progress = emptyPracticeProgress();
  let ts = start;
  const scope = scopeOf(exercise);
  for (let index = 0; index < attempts; index += 1) {
    progress = recordPracticeAttempt(progress, scope, (ts += 1000));
  }
  for (let index = 0; index < completions; index += 1) {
    progress = recordPracticeCompletion(progress, scope, (ts += 1000));
  }
  for (let index = 0; index < hints; index += 1) {
    progress = recordPracticeHint(progress, scope, (ts += 1000));
  }
  return progress;
}

const NOW = new Date("2026-06-15T12:00:00Z");

function reportFor(practice, lessons = emptyLessonProgress(), now = NOW) {
  return buildCoachingReport(coachingSnapshotFromLocal(lessons, practice), now);
}

function snapshotWithHistory(history) {
  return sanitizeCoachingSnapshot({ practice: { history } });
}

// ── Empty and insufficient records ────────────────────────────────────────

test("an empty learning record produces an empty coaching report", () => {
  const report = buildCoachingReport(emptyCoachingSnapshot(), NOW);

  assert.equal(report.insufficientData, true);
  assert.deepEqual(report.skills, []);
  assert.deepEqual(report.difficulties, []);
  assert.deepEqual(report.history, []);
  assert.deepEqual(report.recommendations, []);
  assert.equal(report.weakSkills.length, 0);
  assert.equal(report.comparison.comparable, false);
  assert.equal(report.plan.available, false);
  assert.equal(report.plan.reasonKey, "noPracticeData");
  assert.equal(report.totals.practiceAttempts, 0);
  assert.equal(report.totals.lessonsAvailable, LESSON_CATALOG.length);
  assert.equal(report.totals.coursesAvailable, LESSON_COURSES.length);
  assert.ok(report.reasons.includes("noPractice"));
  assert.ok(report.reasons.includes("noHistory"));
});

test("two attempts are not enough to diagnose a weakness or build a plan", () => {
  const exercise = findPracticeExercise("alternating-colors");
  const report = reportFor(progressFor(exercise, { attempts: 2, completions: 0 }));

  assert.equal(report.insufficientData, true);
  assert.equal(report.totals.practiceAttempts, 2);
  assert.deepEqual(report.weakSkills, []);
  assert.deepEqual(report.recommendations, []);
  assert.equal(report.plan.available, false);
  assert.equal(report.plan.reasonKey, "notEnoughData");
  assert.ok(report.reasons.includes("notEnoughPractice"));
});

test("existing lesson progress is reported without being modified", () => {
  const lesson = LESSON_CATALOG.find((entry) => entry.steps.length > 1);
  assert.ok(lesson, "the catalog needs a multi-step lesson for this test");

  let lessons = emptyLessonProgress();
  lessons = recordLessonProgress(lessons, { lessonId: lesson.id, stepIndex: 1 });
  const before = JSON.stringify(lessons);

  const report = reportFor(emptyPracticeProgress(), lessons);
  assert.equal(JSON.stringify(lessons), before, "coaching must not write progress");
  assert.equal(report.lessons.inProgress.length, 1);
  assert.equal(report.lessons.inProgress[0].lessonId, lesson.id);
  assert.equal(report.lessons.inProgress[0].stepIndex, 1);
  assert.equal(report.lessons.inProgress[0].totalSteps, lesson.steps.length);

  const completed = recordLessonProgress(lessons, {
    lessonId: lesson.id,
    stepIndex: lesson.steps.length,
    completed: true,
  });
  const completedReport = reportFor(emptyPracticeProgress(), completed);
  assert.equal(completedReport.totals.lessonsCompleted, 1);
  assert.ok(completedReport.lessons.completedLessonIds.includes(lesson.id));
});

test("an unfinished lesson yields a factual resume suggestion, not a weakness", () => {
  const lesson = LESSON_CATALOG.find((entry) => entry.steps.length > 1);
  const lessons = recordLessonProgress(emptyLessonProgress(), {
    lessonId: lesson.id,
    stepIndex: 1,
  });
  const report = reportFor(emptyPracticeProgress(), lessons);

  assert.equal(report.insufficientData, true);
  assert.deepEqual(report.weakSkills, []);
  assert.equal(report.recommendations.length, 1);
  assert.equal(report.recommendations[0].kind, "lesson");
  assert.equal(report.recommendations[0].lessonId, lesson.id);
  assert.equal(report.recommendations[0].reasonKey, "resumeLesson");
  assert.equal(report.plan.available, true);
  assert.equal(report.plan.focusSkillId, null);
  assert.equal(report.plan.lessonId, lesson.id);
  assert.deepEqual(report.plan.items, [
    { kind: "lesson", lessonId: lesson.id, minutes: 5 },
  ]);
});

// ── Supported weakness, recommendation and plan ───────────────────────────

test("a low success rate with enough attempts is a supported weakness", () => {
  const exercise = findPracticeExercise("alternating-colors");
  const practice = progressFor(exercise, {
    attempts: 3,
    completions: 1,
    hints: 1,
  });
  const report = reportFor(practice);

  assert.equal(report.insufficientData, false);
  assert.equal(report.weakSkills.length, 1);
  assert.equal(report.weakSkills[0].skillId, exercise.skillId);
  assert.equal(report.weakSkills[0].attempts, 3);
  assert.equal(report.weakSkills[0].successRate, 33);
  assert.equal(report.weakSkills[0].unfinished, 2);

  const recommendation = report.recommendations.find(
    (entry) => entry.kind === "practice",
  );
  assert.ok(recommendation, "a supported weakness must produce a drill");
  assert.equal(recommendation.skillId, exercise.skillId);
  assert.equal(recommendation.reasonKey, "lowSuccess");
  assert.equal(recommendation.difficulty, practiceDifficultiesFor(exercise.skillId)[0]);
  assert.ok(findPracticeExercise(recommendation.exerciseId), recommendation.exerciseId);
  assert.equal(
    findPracticeExercise(recommendation.exerciseId).skillId,
    exercise.skillId,
  );

  assert.equal(report.plan.available, true);
  assert.equal(report.plan.reasonKey, "focusWeakSkill");
  assert.equal(report.plan.focusSkillId, exercise.skillId);
  assert.equal(report.plan.difficulty, recommendedLevel(exercise.skillId));
  const practiceItems = report.plan.items.filter((item) => item.kind === "practice");
  assert.ok(practiceItems.length >= 1);
  for (const item of practiceItems) {
    const drill = findPracticeExercise(item.exerciseId);
    assert.equal(drill.skillId, exercise.skillId);
    assert.equal(drill.difficulty, report.plan.difficulty);
  }
  assert.equal(
    report.plan.dailyMinutes,
    report.plan.items.reduce((total, item) => total + item.minutes, 0),
  );
});

function recommendedLevel(skillId) {
  return practiceDifficultiesFor(skillId)[0];
}

test("hint reliance is reported from the hint total, not guessed", () => {
  const exercise = findPracticeExercise("alternating-colors");
  // 2 attempts, both completed, but one hint per attempt: a supported signal.
  const practice = progressFor(exercise, {
    attempts: 2,
    completions: 2,
    hints: 2,
  });
  const report = reportFor(practice);

  assert.equal(report.insufficientData, true, "2 attempts is below the practice minimum");
  assert.deepEqual(report.weakSkills, []);

  const withMore = progressFor(exercise, {
    attempts: 4,
    completions: 4,
    hints: 4,
  });
  const supported = reportFor(withMore);
  assert.equal(supported.weakSkills.length, 1);
  assert.equal(supported.weakSkills[0].successRate, 100);
  assert.equal(supported.weakSkills[0].hints, 4);
  assert.equal(
    supported.recommendations.find((entry) => entry.kind === "practice")?.reasonKey,
    "hintReliance",
  );
});

test("strong results recommend a harder drill instead of inventing a weakness", () => {
  const exercise = findPracticeExercise("alternating-colors");
  const levels = practiceDifficultiesFor(exercise.skillId);
  assert.ok(levels.length >= 2, "this test needs a skill with two levels");

  // 3 attempts is the practice minimum; all completed and no hints means the
  // record supports moving up rather than a weakness.
  const practice = progressFor(exercise, { attempts: 3, completions: 3 });
  const report = reportFor(practice);

  assert.deepEqual(report.weakSkills, []);
  const recommendation = report.recommendations.find(
    (entry) => entry.kind === "practice",
  );
  assert.ok(recommendation);
  assert.equal(recommendation.reasonKey, "readyForNextLevel");
  assert.equal(recommendation.skillId, exercise.skillId);
  assert.deepEqual(recommendation.difficulty, levels[1]);
  assert.equal(
    findPracticeExercise(recommendation.exerciseId).difficulty,
    levels[1],
  );
});

// ── Analytics ─────────────────────────────────────────────────────────────

test("skill and difficulty analytics come from the recorded buckets", () => {
  const beginner = findPracticeExercise("alternating-colors");
  const advanced = findPracticeExercise("managing-kings");

  let practice = progressFor(beginner, { attempts: 2, completions: 1, hints: 1 });
  practice = recordPracticeAttempt(practice, scopeOf(advanced), Date.parse("2026-06-11T10:00:00Z"));

  const report = reportFor(practice);
  const beginnerStat = report.skills.find((skill) => skill.skillId === beginner.skillId);
  const advancedStat = report.skills.find((skill) => skill.skillId === advanced.skillId);

  assert.deepEqual(
    { attempts: beginnerStat.attempts, completions: beginnerStat.completions },
    { attempts: 2, completions: 1 },
  );
  assert.equal(beginnerStat.successRate, 50);
  assert.equal(advancedStat.successRate, 0);
  assert.deepEqual(
    report.difficulties.map((entry) => [entry.difficulty, entry.attempts]),
    [["beginner", 2], ["advanced", 1]],
  );
  assert.equal(report.totals.exercisesAttempted, 2);
  assert.equal(report.totals.exercisesCompleted, 1);
  assert.equal(report.totals.successRate, 33);
  assert.equal(report.totals.hints, 1);
});

// ── History and comparison ────────────────────────────────────────────────

test("a week-to-week comparison needs real attempts in both weeks", () => {
  const onlyCurrent = reportFor(
    emptyPracticeProgress(),
    emptyLessonProgress(),
    NOW,
  );
  assert.equal(onlyCurrent.comparison.comparable, false);
  assert.equal(onlyCurrent.comparison.reasonKey, "notEnoughHistory");

  const snapshot = snapshotWithHistory({
    "2026-06-14": { attempts: 3, completions: 3, hints: 0 },
    "2026-06-07": { attempts: 3, completions: 1, hints: 2 },
  });
  const report = buildCoachingReport(snapshot, NOW);

  assert.equal(report.comparison.comparable, true);
  assert.equal(report.comparison.windowDays, 7);
  assert.equal(report.comparison.current.attempts, 3);
  assert.equal(report.comparison.previous.attempts, 3);
  assert.equal(report.comparison.currentSuccessRate, 100);
  assert.equal(report.comparison.previousSuccessRate, 33);
  assert.equal(report.comparison.delta.successRate, 67);
  assert.equal(report.comparison.delta.attempts, 0);
  assert.equal(report.comparison.delta.hints, -2);
});

test("a one-sided week is never compared", () => {
  const snapshot = snapshotWithHistory({
    "2026-06-14": { attempts: 9, completions: 9, hints: 0 },
  });
  const report = buildCoachingReport(snapshot, NOW);
  assert.equal(report.comparison.comparable, false);
});

test("the history series is sorted and capped at 30 days", () => {
  const days = [];
  const history = {};
  for (let index = 0; index < 40; index += 1) {
    const date = new Date(Date.UTC(2026, 4, 1 + index));
    const key = date.toISOString().slice(0, 10);
    days.push(key);
    history[key] = { attempts: 1, completions: index % 2, hints: 0 };
  }

  const report = buildCoachingReport(snapshotWithHistory(history), NOW);
  assert.equal(report.history.length, COACHING_THRESHOLDS.historyDays);
  assert.equal(report.history[0].dayKey, days[days.length - 30]);
  assert.equal(report.history[report.history.length - 1].dayKey, days[days.length - 1]);
  assert.deepEqual(
    report.history.map((entry) => entry.dayKey),
    [...report.history.map((entry) => entry.dayKey)].sort(),
  );
});

test("practice progress records one history bucket per UTC day", () => {
  const exercise = findPracticeExercise("alternating-colors");
  const evening = Date.parse("2026-06-01T23:30:00Z");
  let progress = emptyPracticeProgress();
  progress = recordPracticeAttempt(progress, scopeOf(exercise), evening);
  progress = recordPracticeCompletion(progress, scopeOf(exercise), evening + 1000);
  progress = recordPracticeHint(progress, scopeOf(exercise), evening + 2000);

  assert.deepEqual(progress.history[practiceDayKey(evening)], {
    attempts: 1,
    completions: 1,
    hints: 1,
  });
  assert.equal(Object.keys(progress.history).length, 1);

  const legacy = normalizePracticeProgress({
    attempts: 1,
    byExercise: {
      "alternating-colors": { attempts: 1, completions: 0, hints: 0 },
    },
  });
  assert.deepEqual(legacy.history, {}, "an older payload has no invented history");
});

// ── Snapshot trust ────────────────────────────────────────────────────────

test("unknown ids are dropped and aggregates are recomputed", () => {
  const lesson = LESSON_BY_ID["reveal-a-card"];
  assert.ok(lesson);

  const normalized = sanitizeCoachingSnapshot({
    pro: true,
    tier: "pro",
    lessons: {
      completedLessonIds: ["reveal-a-card", "retired-lesson"],
      stepIndexByLesson: { "reveal-a-card": 9999, "retired-lesson": 2 },
    },
    practice: {
      attempts: 999,
      byExercise: {
        "alternating-colors": { attempts: 2, completions: 5, hints: 1 },
        "retired-drill": { attempts: 4, completions: 4, hints: 0 },
      },
      bySkill: { "retired-skill": { attempts: 50, completions: 50, hints: 0 } },
      byDifficulty: {
        beginner: { attempts: 50, completions: 50, hints: 0 },
        expert: { attempts: 50, completions: 50, hints: 0 },
      },
      history: {
        "2026-06-01": { attempts: 1, completions: 0, hints: 0 },
        "not-a-day": { attempts: 9, completions: 9, hints: 9 },
      },
    },
  });

  assert.deepEqual(normalized.lessons.completedLessonIds, ["reveal-a-card"]);
  assert.equal(
    normalized.lessons.stepIndexByLesson["reveal-a-card"],
    lesson.steps.length,
  );
  assert.equal(normalized.lessons.stepIndexByLesson["retired-lesson"], undefined);
  assert.equal(normalized.practice.attempts, 2, "totals come from real drills");
  assert.equal(normalized.practice.completions, 2, "completions are clamped");
  assert.deepEqual(normalized.practice.bySkill, {
    "alternating-colors": { attempts: 2, completions: 2, hints: 1 },
  });
  assert.deepEqual(normalized.practice.byDifficulty.beginner, {
    attempts: 2,
    completions: 2,
    hints: 1,
  });
  assert.equal(normalized.practice.byDifficulty.advanced.attempts, 0);
  assert.deepEqual(Object.keys(normalized.practice.history), ["2026-06-01"]);
  assert.deepEqual(sanitizeCoachingSnapshot("nonsense"), emptyCoachingSnapshot());
});

test("a client-claimed Pro tier buys nothing in the snapshot", () => {
  const report = buildCoachingReport(
    sanitizeCoachingSnapshot({ pro: true, tier: "pro", premium: true }),
    NOW,
  );
  assert.deepEqual(report.skills, []);
  assert.equal(report.plan.available, false);
  assert.equal(report.totals.practiceAttempts, 0);
});

test("every skill maps to a real lesson", () => {
  for (const skill of PRACTICE_SKILLS) {
    const lessonId = SKILL_LESSON_ID[skill.id];
    assert.ok(lessonId, `${skill.id} has no lesson mapping`);
    assert.ok(LESSON_BY_ID[lessonId], `${skill.id} maps to missing lesson ${lessonId}`);
  }
  // Two stock skills share the stock-cycles lesson on purpose; every entry is
  // still a real lesson, and no mapping points at an unknown skill.
  for (const skillId of Object.keys(SKILL_LESSON_ID)) {
    assert.ok(PRACTICE_SKILLS.some((skill) => skill.id === skillId), skillId);
  }
});

// ── Subscription and server-side enforcement ──────────────────────────────

test("the coaching route resolves membership itself, before reading the body", () => {
  const route = read(ROUTE_SOURCE);

  assert.match(route, /getMembershipTier\(userId\)/);
  assert.match(route, /withTimeout/);
  assert.match(route, /consumeRateLimit/);
  assert.match(route, /status: 401/);
  assert.match(route, /status: 503/);
  assert.match(route, /Cache-Control/);

  const gateIndex = route.indexOf("getMembershipTier(userId)");
  const bodyIndex = route.indexOf("await request.text()");
  assert.ok(gateIndex > 0, "membership must be resolved in the route");
  assert.ok(bodyIndex > gateIndex, "the gate must run before the body is read");

  assert.doesNotMatch(route, /request\.json\(\)/);
  assert.doesNotMatch(route, /body\.(pro|tier|premium|isPro)/);
  assert.doesNotMatch(route, /searchParams/);
});

test("a non-member receives the explanation and no analytics", () => {
  const route = read(ROUTE_SOURCE);
  const locked = route.slice(
    route.indexOf("function lockedPayload"),
    route.indexOf("export async function POST"),
  );

  assert.match(locked, /locked: true/);
  assert.match(locked, /upgradeUrl/);
  assert.match(locked, /benefitKeys/);
  assert.doesNotMatch(locked, /report/, "the locked payload must not carry a report");
  assert.doesNotMatch(route, /COACHING_BENEFIT_KEYS[^;]*report/);
});

test("coaching never writes a database, a lesson record or practice progress", () => {
  for (const file of [ROUTE_SOURCE, ENGINE_SOURCE]) {
    const source = read(file);
    assert.doesNotMatch(source, /from\s+["'][^"']*\/db\//, file);
    assert.doesNotMatch(source, /drizzle|serverStore|localStorage\.setItem/, file);
    assert.doesNotMatch(source, /writeLessonProgress|writePracticeProgress/, file);
    assert.doesNotMatch(source, /\bfetch\s*\(/, file);
  }
  assert.match(read(ENGINE_SOURCE), /deterministic/i);
  assert.match(read(ENGINE_SOURCE), /sanitizeCoachingSnapshot/);
});

test("expiry and plan changes cannot corrupt learning progress", () => {
  const storage = {
    map: new Map(),
    getItem(key) {
      return this.map.has(key) ? this.map.get(key) : null;
    },
    setItem(key, value) {
      this.map.set(key, String(value));
    },
  };

  const lesson = LESSON_CATALOG[0];
  let lessons = recordLessonProgress(emptyLessonProgress(), {
    lessonId: lesson.id,
    stepIndex: lesson.steps.length,
    completed: true,
  });
  writeLessonProgress(storage, "user_member", lessons);
  const before = readLessonProgress(storage, "user_member");
  assert.ok(before.completedLessonIds.includes(lesson.id));

  // A Pro report is built, then the same player is treated as expired: the
  // coaching modules have no write path, so the stored record is identical.
  const proReport = reportFor(emptyPracticeProgress(), before);
  assert.equal(proReport.totals.lessonsCompleted, 1);
  const after = readLessonProgress(storage, "user_member");
  assert.deepEqual(after, before);

  // The gate re-resolves on every request; no tier is trusted from the client.
  const client = read(CLIENT_SOURCE);
  assert.doesNotMatch(client, /localStorage[^;]*pro\b/i);
  assert.match(read(ROUTE_SOURCE), /getMembershipTier\(userId\)/);
});

// ── Guest, UI and privacy ─────────────────────────────────────────────────

test("guests see a sign-in explanation and no report request is made", () => {
  const client = read(CLIENT_SOURCE);
  assert.match(client, /signedIn/);
  assert.match(client, /coaching-guest/);
  assert.match(
    client,
    /if \(!signedIn \|\| !pro \|\| membershipUnavailable \|\| !recordsReady\) return undefined;/,
  );
  assert.match(client, /fetch\("\/api\/learn\/coaching"/);
  assert.doesNotMatch(client, /role="dialog"|createPortal|setInterval/);
});

test("the page resolves membership on the server and is not indexed", () => {
  const page = read(PAGE_SOURCE);
  assert.match(page, /getMembershipTier/);
  assert.match(page, /withTimeout/);
  assert.match(page, /force-dynamic/);
  assert.match(page, /index: false, follow: false/);
  assert.match(page, /signedIn=\{Boolean\(userId\)\}/);
  assert.match(page, /membershipUnavailable=\{membershipUnavailable\}/);
});

test("the client posts only its own local record and renders server data", () => {
  const client = read(CLIENT_SOURCE);
  assert.match(client, /coachingSnapshotFromLocal/);
  assert.match(client, /method: "POST"/);
  assert.match(client, /cache: "no-store"/);
  assert.doesNotMatch(client, /buildCoachingReport/);
  assert.doesNotMatch(client, /PRACTICE_PROGRESS_STORAGE|LESSON_PROGRESS_STORAGE/);
  for (const id of [
    "coaching-guest",
    "coaching-locked",
    "coaching-unavailable",
    "coaching-error",
    "coaching-report",
    "coaching-skills",
    "coaching-difficulties",
    "coaching-history",
    "coaching-comparison",
    "coaching-weak",
    "coaching-recommendations",
    "coaching-plan",
  ]) {
    assert.match(client, new RegExp(`data-testid="${id}"`), id);
  }
  assert.doesNotMatch(client, /match|opponent|hidden card/i);
});

test("coaching recommends drills through validated practice deep links", () => {
  const client = read(CLIENT_SOURCE);
  assert.match(client, /COACHING_PRACTICE_PATH/);
  assert.match(client, /URLSearchParams\(\{ skill: skillId \}\)/);

  const route = read(PRACTICE_PAGE_SOURCE);
  assert.match(route, /searchParams/);
  assert.match(route, /initialSkillId/);
  assert.match(route, /initialDifficulty/);

  const practice = read(PRACTICE_SOURCE);
  assert.match(practice, /practiceSkill\(initialSkillId\)/);
  assert.match(practice, /practiceDifficultiesFor/);
  assert.match(practice, /practice-coaching-entry/);
  assert.match(practice, /practice-coaching-link/);
});

test("fundamental learning stays free and out of the coaching gate", () => {
  const route = read(ROUTE_SOURCE);
  assert.doesNotMatch(route, /lessons\//);
  assert.doesNotMatch(route, /courses\//);

  const note = LEARN_TRANSLATIONS.en.coaching.locked.note;
  assert.match(note, /five courses/i);
  assert.match(note, /20 lessons/i);
  assert.match(note, /basic practice/i);

  // Coaching is not a product/benefit row, so no Stripe product is modified.
  const benefits = read("src/lib/proBenefits.ts");
  assert.doesNotMatch(benefits, /coaching/i);
  assert.doesNotMatch(read(ROUTE_SOURCE), /stripe\/products|price_|PRO_BENEFIT/);
});

// ── Localization ──────────────────────────────────────────────────────────

function leaves(value, prefix = "", out = {}) {
  for (const [key, entry] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === "object") leaves(entry, next, out);
    else out[next] = entry;
  }
  return out;
}

test("every coaching string exists in English, French and Spanish", () => {
  const english = leaves(LEARN_COACHING_TRANSLATIONS.en);
  const french = leaves(LEARN_COACHING_TRANSLATIONS.fr);
  const spanish = leaves(LEARN_COACHING_TRANSLATIONS.es);

  assert.ok(Object.keys(english).length > 80, "expected a complete bundle");
  assert.deepEqual(Object.keys(french).sort(), Object.keys(english).sort());
  assert.deepEqual(Object.keys(spanish).sort(), Object.keys(english).sort());

  for (const [language, bundle] of [
    ["en", english],
    ["fr", french],
    ["es", spanish],
  ]) {
    for (const [key, value] of Object.entries(bundle)) {
      assert.equal(typeof value, "string", `${language}.${key}`);
      assert.ok(value.trim().length > 0, `${language}.${key} is empty`);
    }
  }
});

test("French and Spanish are genuinely translated", () => {
  const english = leaves(LEARN_COACHING_TRANSLATIONS.en);
  const keys = Object.keys(english);
  for (const [language, bundle] of [
    ["fr", leaves(LEARN_COACHING_TRANSLATIONS.fr)],
    ["es", leaves(LEARN_COACHING_TRANSLATIONS.es)],
  ]) {
    const translated = keys.filter((key) => bundle[key] !== english[key]).length;
    assert.ok(translated > 70, `${language} only ${translated} strings differ`);
  }
});

test("the coaching bundle and its entries are mounted in all locales", () => {
  for (const language of ["en", "fr", "es"]) {
    assert.equal(
      APP_TEXT_TRANSLATIONS[language].learn.coaching,
      LEARN_COACHING_TRANSLATIONS[language],
    );
    for (const key of [
      "destinations.coaching.title",
      "destinations.coaching.description",
      "destinations.coaching.meta",
      "destinations.coaching.cta",
      "subnav.coaching",
      "coaching.practiceEntry.title",
      "coaching.practiceEntry.cta",
    ]) {
      const value = key
        .split(".")
        .reduce((entry, part) => entry?.[part], LEARN_TRANSLATIONS[language]);
      assert.equal(typeof value, "string", `${language} missing ${key}`);
      assert.ok(value.length > 0, `${language} empty ${key}`);
    }
    for (const key of COACHING_BENEFIT_KEYS) {
      const value = key
        .replace(/^learn\./, "")
        .split(".")
        .reduce((entry, part) => entry?.[part], LEARN_TRANSLATIONS[language]);
      assert.equal(typeof value, "string", `${language} missing ${key}`);
    }
  }
});

test("no coaching copy calls a legal move a mistake", () => {
  const english = leaves(LEARN_COACHING_TRANSLATIONS.en);
  for (const [key, value] of Object.entries(english)) {
    assert.doesNotMatch(value, /\bmistake\b|\bwrong move\b|\bblunder\b/i, key);
  }
});
