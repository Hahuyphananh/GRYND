// src/lib/learn/coaching.ts
//
// GRYND PRO ADVANCED COACHING — the deterministic analytics, recommendation and
// training-plan engine for the Academy.
//
// ── WHERE THE DATA COMES FROM ─────────────────────────────────────────────
//
// Learning progress is device-local (lessonProgress.ts / practiceProgress.ts),
// exactly as it was before this phase. This module never invents progress: the
// client sends the player's OWN local record, `sanitizeCoachingSnapshot` drops
// anything it cannot verify against the authored catalog, and
// `buildCoachingReport` derives every number from that sanitized snapshot.
//
// The server route (/api/learn/coaching) is what enforces GRYND PRO. This
// module is deliberately pure and server-safe: no network, no database, no AI,
// no client storage, so the same functions can run in tests without Clerk or
// Stripe.
//
// ── HONESTY RULES ─────────────────────────────────────────────────────────
//
//   * Weakness detection has a MINIMUM SAMPLE. A player who attempted a drill
//     once is not labelled weak; `COACHING_THRESHOLDS` is the only place those
//     numbers live.
//   * Insufficient data produces `insufficientData` and NO practice-based
//     recommendation. The one recommendation that can still appear is "resume
//     the lesson you actually started", which is a recorded fact, not a guess.
//   * Historical comparison is only emitted when BOTH the current and previous
//     windows have enough attempts. Otherwise `comparison` is null.
//   * A "struggle" is an unfinished attempt, a low exercise success rate or
//     hint reliance. The engine never calls a legal move a mistake: exercise
//     evaluation is state-based and does not grade individual moves.
//   * Everything is deterministic: orderings come from the authored catalogs,
//     there is no randomness and no external model.

import { LESSON_CATALOG, LESSON_BY_ID, LESSON_COURSES } from "../solitaire-duel/lessonCatalog";
import {
  PRACTICE_DIFFICULTIES,
  PRACTICE_SKILL_BY_ID,
  PRACTICE_SKILLS,
  findPracticeExercise,
  practiceDifficultiesFor,
  practiceExercisesFor,
  type PracticeCategoryId,
  type PracticeDifficulty,
} from "../solitaire-duel/practice";
import { courseState, recommendedLesson } from "../solitaire-duel/lessonProgress";
import type { LessonProgressState } from "../solitaire-duel/lessonProgress";
import type {
  PracticeBucket,
  PracticeProgressState,
} from "../solitaire-duel/practiceProgress";

// ── Public constants ──────────────────────────────────────────────────────

/**
 * Every threshold the coaching engine uses. Named here so the UI copy ("we need
 * a few more drills") and the tests can point at the same numbers rather than
 * at a magic value buried in a sort.
 */
export const COACHING_THRESHOLDS = Object.freeze({
  /** A skill needs this many attempts before it can be called a weak area. */
  minAttemptsPerSkill: 2,
  /** Total practice attempts before practice-based recommendations appear. */
  minPracticeAttempts: 3,
  /** Below this success rate, with enough attempts, a skill is a weak area. */
  lowSuccessRate: 60,
  /** Both comparison windows need this many attempts to compare them. */
  comparisonMinAttempts: 3,
  /** A skill at/above this rate (with no hints) is ready for a harder drill. */
  readySuccessRate: 80,
  /** Maximum weak skills reported / recommended. */
  maxWeakSkills: 3,
  /** Maximum practice recommendations. */
  maxPracticeRecommendations: 2,
  /** How many days of local history the report carries. */
  historyDays: 30,
  /** The comparison window length, in days. */
  comparisonWindowDays: 7,
});

/** What the locked (free) response tells the client the feature does. */
export const COACHING_BENEFIT_KEYS = Object.freeze([
  "learn.coaching.locked.point1",
  "learn.coaching.locked.point2",
  "learn.coaching.locked.point3",
  "learn.coaching.locked.point4",
]);

/** The single upgrade URL every coaching surface uses. */
export const COACHING_UPGRADE_URL = "/upgrade-pro";

/** Where a coaching recommendation sends the player. */
export const COACHING_PRACTICE_PATH = "/learn/practice";

// ── Snapshot ──────────────────────────────────────────────────────────────

export type CoachingBucket = {
  readonly attempts: number;
  readonly completions: number;
  readonly hints: number;
};

export type CoachingSnapshot = {
  readonly lessons: {
    readonly completedLessonIds: readonly string[];
    readonly stepIndexByLesson: Readonly<Record<string, number>>;
  };
  readonly practice: {
    readonly attempts: number;
    readonly completions: number;
    readonly hints: number;
    readonly byExercise: Readonly<Record<string, CoachingBucket>>;
    readonly bySkill: Readonly<Record<string, CoachingBucket>>;
    readonly byDifficulty: Readonly<Record<PracticeDifficulty, CoachingBucket>>;
    /** UTC day (`YYYY-MM-DD`) → activity. */
    readonly history: Readonly<Record<string, CoachingBucket>>;
  };
};

const EMPTY_BUCKET: CoachingBucket = Object.freeze({ attempts: 0, completions: 0, hints: 0 });
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_HISTORY_DAYS = 400;
/** A sanity cap: no honest local record reaches this within one field. */
const MAX_COUNT = 100_000;

function emptyDifficultyBuckets(): Record<PracticeDifficulty, CoachingBucket> {
  return {
    beginner: { ...EMPTY_BUCKET },
    intermediate: { ...EMPTY_BUCKET },
    advanced: { ...EMPTY_BUCKET },
  };
}

export function emptyCoachingSnapshot(): CoachingSnapshot {
  return {
    lessons: { completedLessonIds: [], stepIndexByLesson: {} },
    practice: {
      attempts: 0,
      completions: 0,
      hints: 0,
      byExercise: {},
      bySkill: {},
      byDifficulty: emptyDifficultyBuckets(),
      history: {},
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(MAX_COUNT, Math.max(0, Math.floor(value)));
}

function bucketOf(value: unknown): CoachingBucket {
  if (!isRecord(value)) return { ...EMPTY_BUCKET };
  return {
    attempts: count(value.attempts),
    completions: count(value.completions),
    hints: count(value.hints),
  };
}

function addBucket(base: CoachingBucket, patch: CoachingBucket): CoachingBucket {
  return {
    attempts: base.attempts + patch.attempts,
    completions: base.completions + patch.completions,
    hints: base.hints + patch.hints,
  };
}

/**
 * The ONLY accepted shape from the client.
 *
 * Every id is checked against the authored catalogs, counts are clamped, and
 * the skill/difficulty/total aggregates are RECOMPUTED from the per-exercise
 * buckets — so a forged or stale payload cannot file a drill under the wrong
 * skill or inflate a success rate.
 */
export function sanitizeCoachingSnapshot(value: unknown): CoachingSnapshot {
  if (!isRecord(value)) return emptyCoachingSnapshot();

  const lessonSource = isRecord(value.lessons) ? value.lessons : {};
  const completedLessonIds = Array.isArray(lessonSource.completedLessonIds)
    ? [
        ...new Set(
          lessonSource.completedLessonIds.filter(
            (id): id is string => typeof id === "string" && Boolean(LESSON_BY_ID[id]),
          ),
        ),
      ]
    : [];

  const stepIndexByLesson: Record<string, number> = {};
  if (isRecord(lessonSource.stepIndexByLesson)) {
    for (const [id, raw] of Object.entries(lessonSource.stepIndexByLesson)) {
      const lesson = LESSON_BY_ID[id];
      if (!lesson) continue;
      stepIndexByLesson[id] = Math.min(lesson.steps.length, count(raw));
    }
  }

  const practiceSource = isRecord(value.practice) ? value.practice : {};
  const byExercise: Record<string, CoachingBucket> = {};
  if (isRecord(practiceSource.byExercise)) {
    for (const [id, raw] of Object.entries(practiceSource.byExercise)) {
      if (!findPracticeExercise(id)) continue;
      const bucket = bucketOf(raw);
      // A completion is a kind of attempt: never let completions exceed them.
      byExercise[id] = {
        attempts: bucket.attempts,
        completions: Math.min(bucket.attempts, bucket.completions),
        hints: bucket.hints,
      };
    }
  }

  const bySkill: Record<string, CoachingBucket> = {};
  const byDifficulty = emptyDifficultyBuckets();
  let attempts = 0;
  let completions = 0;
  let hints = 0;
  for (const [exerciseId, bucket] of Object.entries(byExercise)) {
    const exercise = findPracticeExercise(exerciseId);
    if (!exercise) continue;
    bySkill[exercise.skillId] = addBucket(
      bySkill[exercise.skillId] ?? EMPTY_BUCKET,
      bucket,
    );
    byDifficulty[exercise.difficulty] = addBucket(byDifficulty[exercise.difficulty], bucket);
    attempts += bucket.attempts;
    completions += bucket.completions;
    hints += bucket.hints;
  }

  const history: Record<string, CoachingBucket> = {};
  if (isRecord(practiceSource.history)) {
    const days = Object.keys(practiceSource.history)
      .filter((day) => DAY_KEY.test(day) && Number.isFinite(Date.parse(`${day}T00:00:00Z`)))
      .sort()
      .slice(-MAX_HISTORY_DAYS);
    for (const day of days) history[day] = bucketOf(practiceSource.history[day]);
  }

  return {
    lessons: { completedLessonIds, stepIndexByLesson },
    practice: {
      attempts,
      completions,
      hints,
      byExercise,
      bySkill,
      byDifficulty,
      history,
    },
  };
}

/** Build the snapshot from the two device-local records this browser holds. */
export function coachingSnapshotFromLocal(
  lessonProgress: Pick<
    LessonProgressState,
    "completedLessonIds" | "stepIndexByLesson"
  > | null,
  practiceProgress: Pick<
    PracticeProgressState,
    "attempts" | "completions" | "hints" | "byExercise" | "bySkill" | "byDifficulty" | "history"
  > | null,
): CoachingSnapshot {
  const source = {
    lessons: {
      completedLessonIds: lessonProgress?.completedLessonIds ?? [],
      stepIndexByLesson: lessonProgress?.stepIndexByLesson ?? {},
    },
    practice: {
      attempts: practiceProgress?.attempts ?? 0,
      completions: practiceProgress?.completions ?? 0,
      hints: practiceProgress?.hints ?? 0,
      byExercise: practiceProgress?.byExercise ?? {},
      bySkill: practiceProgress?.bySkill ?? {},
      byDifficulty: practiceProgress?.byDifficulty ?? emptyDifficultyBuckets(),
      history: practiceProgress?.history ?? {},
    },
  };
  return sanitizeCoachingSnapshot(source);
}

// ── Report types ──────────────────────────────────────────────────────────

export type CoachingSkillStat = {
  readonly skillId: string;
  readonly categoryId: PracticeCategoryId;
  readonly attempts: number;
  readonly completions: number;
  readonly hints: number;
  readonly successRate: number;
  /** Attempts without a recorded completion: a struggle signal, not a verdict. */
  readonly unfinished: number;
};

export type CoachingDifficultyStat = {
  readonly difficulty: PracticeDifficulty;
  readonly attempts: number;
  readonly completions: number;
  readonly hints: number;
  readonly successRate: number;
};

export type CoachingLessonStat = {
  readonly lessonId: string;
  readonly stepIndex: number;
  readonly totalSteps: number;
};

export type CoachingRecommendation =
  | {
      readonly kind: "practice";
      readonly skillId: string;
      readonly categoryId: PracticeCategoryId;
      readonly exerciseId: string;
      readonly difficulty: PracticeDifficulty;
      readonly reasonKey: string;
    }
  | {
      readonly kind: "lesson";
      readonly lessonId: string;
      readonly skillId: string | null;
      readonly reasonKey: string;
    };

export type CoachingPlanItem =
  | {
      readonly kind: "practice";
      readonly exerciseId: string;
      readonly skillId: string;
      readonly difficulty: PracticeDifficulty;
      readonly minutes: number;
    }
  | {
      readonly kind: "lesson";
      readonly lessonId: string;
      readonly minutes: number;
    };

export type CoachingPlan =
  | {
      readonly available: true;
      readonly reasonKey: string;
      readonly focusSkillId: string | null;
      readonly focusCategoryId: PracticeCategoryId | null;
      readonly difficulty: PracticeDifficulty | null;
      readonly lessonId: string | null;
      readonly dailyMinutes: number;
      readonly items: readonly CoachingPlanItem[];
    }
  | {
      readonly available: false;
      readonly reasonKey: string;
    };

export type CoachingReport = {
  readonly generatedAt: string;
  readonly thresholds: typeof COACHING_THRESHOLDS;
  readonly totals: {
    readonly lessonsCompleted: number;
    readonly lessonsAvailable: number;
    readonly coursesCompleted: number;
    readonly coursesAvailable: number;
    readonly practiceAttempts: number;
    readonly practiceCompletions: number;
    readonly exercisesAttempted: number;
    readonly exercisesCompleted: number;
    readonly successRate: number;
    readonly hints: number;
  };
  readonly lessons: {
    readonly inProgress: readonly CoachingLessonStat[];
    readonly completedLessonIds: readonly string[];
    readonly nextLessonId: string | null;
  };
  readonly skills: readonly CoachingSkillStat[];
  readonly difficulties: readonly CoachingDifficultyStat[];
  readonly weakSkills: readonly CoachingSkillStat[];
  readonly history: readonly {
    readonly dayKey: string;
    readonly attempts: number;
    readonly completions: number;
    readonly hints: number;
  }[];
  readonly comparison:
    | {
        readonly comparable: true;
        readonly windowDays: number;
        readonly current: CoachingBucket;
        readonly previous: CoachingBucket;
        readonly currentSuccessRate: number;
        readonly previousSuccessRate: number;
        readonly delta: CoachingBucket & { readonly successRate: number };
      }
    | { readonly comparable: false; readonly reasonKey: string };
  readonly recommendations: readonly CoachingRecommendation[];
  readonly plan: CoachingPlan;
  readonly insufficientData: boolean;
  readonly reasons: readonly string[];
};

// ── Skill → lesson map ────────────────────────────────────────────────────
//
// The lesson that teaches each drill's skill. Both sides are authored data; a
// test asserts every mapping points at a real lesson, so a renamed lesson fails
// the suite rather than silently sending a player to a 404.

export const SKILL_LESSON_ID: Readonly<Record<string, string>> = Object.freeze({
  "alternating-colors": "alternating-colors",
  "descending-sequences": "descending-sequences",
  "moving-runs": "moving-runs",
  "reveal-hidden-cards": "reveal-a-card",
  "opening-empty-columns": "opening-columns",
  "managing-kings": "moving-kings",
  "foundation-timing": "foundation-timing",
  "keeping-tableau-cards": "keeping-tableau-cards",
  "efficient-foundations": "efficient-foundations",
  "stock-draw-decisions": "first-draw",
  "waste-pile-management": "stock-cycles",
  "stock-cycle-planning": "stock-cycles",
  "planning-ahead": "planning-ahead",
  "choosing-reveals": "choosing-reveals",
  "avoiding-blocked-positions": "blocked-columns",
  "comparing-alternative-moves": "choosing-sequences",
});

// ── Helpers ───────────────────────────────────────────────────────────────

function successRate(bucket: CoachingBucket): number {
  return bucket.attempts > 0
    ? Math.round((bucket.completions / bucket.attempts) * 100)
    : 0;
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}

function sumHistory(
  history: CoachingSnapshot["practice"]["history"],
  fromDay: string,
  toDay: string,
): CoachingBucket {
  let total = { ...EMPTY_BUCKET };
  for (const [day, bucket] of Object.entries(history)) {
    // Day keys sort lexicographically, which is why the window is strings.
    if (day >= fromDay && day <= toDay) total = addBucket(total, bucket);
  }
  return total;
}

/** The weakest skills that the data can honestly support, strongest first. */
function findWeakSkills(skills: readonly CoachingSkillStat[]): CoachingSkillStat[] {
  return skills
    .filter((skill) => {
      if (skill.attempts < COACHING_THRESHOLDS.minAttemptsPerSkill) return false;
      return (
        skill.successRate < COACHING_THRESHOLDS.lowSuccessRate ||
        skill.hints >= skill.attempts ||
        skill.unfinished > 0
      );
    })
    .sort((a, b) => {
      if (a.successRate !== b.successRate) return a.successRate - b.successRate;
      if (a.unfinished !== b.unfinished) return b.unfinished - a.unfinished;
      if (a.hints !== b.hints) return b.hints - a.hints;
      return a.skillId.localeCompare(b.skillId);
    })
    .slice(0, COACHING_THRESHOLDS.maxWeakSkills);
}

/** Weakness reason, in priority order, from the recorded numbers alone. */
function weakReasonKey(skill: CoachingSkillStat): string {
  if (skill.successRate < COACHING_THRESHOLDS.lowSuccessRate) return "lowSuccess";
  if (skill.hints >= skill.attempts) return "hintReliance";
  return "unfinished";
}

/**
 * The difficulty a weak skill should be practised at: the easiest authored
 * level for that drill, so a struggling player is not escalated. A player who
 * is ready to move on gets the next difficulty up (see `readySkill`).
 */
function recommendedDifficulty(skillId: string): PracticeDifficulty | null {
  const available = practiceDifficultiesFor(skillId);
  if (available.length === 0) return null;
  return available[0];
}

/**
 * A skill whose record supports moving UP a difficulty: enough attempts, a high
 * success rate, no hints, and an authored harder drill exists.
 */
function findReadySkill(
  skills: readonly CoachingSkillStat[],
  snapshot: CoachingSnapshot,
): { skillId: string; difficulty: PracticeDifficulty } | null {
  const candidates = skills
    .filter(
      (skill) =>
        skill.attempts >= COACHING_THRESHOLDS.minAttemptsPerSkill &&
        skill.successRate >= COACHING_THRESHOLDS.readySuccessRate &&
        skill.hints === 0,
    )
    .sort((a, b) => b.attempts - a.attempts || a.skillId.localeCompare(b.skillId));

  for (const skill of candidates) {
    const available = practiceDifficultiesFor(skill.skillId);
    if (available.length < 2) continue;
    // Which levels have they actually attempted for this skill?
    const attempted = new Set<PracticeDifficulty>();
    for (const [exerciseId, bucket] of Object.entries(snapshot.practice.byExercise)) {
      const exercise = findPracticeExercise(exerciseId);
      if (exercise?.skillId === skill.skillId && bucket.attempts > 0) {
        attempted.add(exercise.difficulty);
      }
    }
    if (attempted.size === 0) continue;
    const attemptedRank = Math.max(
      ...[...attempted].map((level) => PRACTICE_DIFFICULTIES.indexOf(level)),
    );
    const harder = available.find(
      (difficulty) =>
        !attempted.has(difficulty) &&
        PRACTICE_DIFFICULTIES.indexOf(difficulty) > attemptedRank,
    );
    if (harder) return { skillId: skill.skillId, difficulty: harder };
  }
  return null;
}

function lessonSkillId(lessonId: string): string | null {
  for (const [skillId, mapped] of Object.entries(SKILL_LESSON_ID)) {
    if (mapped === lessonId) return skillId;
  }
  return null;
}

// ── Report ────────────────────────────────────────────────────────────────

export function buildCoachingReport(
  snapshot: CoachingSnapshot,
  now: Date = new Date(),
): CoachingReport {
  const practice = snapshot.practice;

  // Skills in catalog order (category, then skill), only those with attempts.
  const skills: CoachingSkillStat[] = PRACTICE_SKILLS.map((skill) => {
    const bucket = practice.bySkill[skill.id] ?? EMPTY_BUCKET;
    return {
      skillId: skill.id,
      categoryId: skill.categoryId,
      attempts: bucket.attempts,
      completions: bucket.completions,
      hints: bucket.hints,
      successRate: successRate(bucket),
      unfinished: Math.max(0, bucket.attempts - bucket.completions),
    };
  }).filter((skill) => skill.attempts > 0);

  const difficulties: CoachingDifficultyStat[] = PRACTICE_DIFFICULTIES.map((difficulty) => {
    const bucket = practice.byDifficulty[difficulty] ?? EMPTY_BUCKET;
    return {
      difficulty,
      attempts: bucket.attempts,
      completions: bucket.completions,
      hints: bucket.hints,
      successRate: successRate(bucket),
    };
  }).filter((entry) => entry.attempts > 0);

  const completedLessonIds = new Set(snapshot.lessons.completedLessonIds);
  const lessonState: LessonProgressState = {
    completedLessonIds: [...completedLessonIds],
    stepIndexByLesson: { ...snapshot.lessons.stepIndexByLesson },
    phaseIndexByLesson: {},
    lastLessonId: null,
    updatedAt: 0,
  };
  const coursesCompleted = LESSON_COURSES.filter((course) => {
    const lessons = LESSON_CATALOG.filter((lesson) => lesson.courseId === course.id);
    return lessons.length > 0 && lessons.every((lesson) => completedLessonIds.has(lesson.id));
  }).length;

  // In-progress lessons are only surfaced when their course is unlocked: a
  // resume suggestion must be a lesson the player can actually open.
  const inProgress: CoachingLessonStat[] = LESSON_CATALOG.filter((lesson) => {
    if (completedLessonIds.has(lesson.id)) return false;
    if (courseState(lessonState, lesson.courseId) === "locked") return false;
    const step = snapshot.lessons.stepIndexByLesson[lesson.id] ?? 0;
    return step > 0 && step < lesson.steps.length;
  })
    .sort((a, b) => {
      const courseA = LESSON_COURSES.find((course) => course.id === a.courseId)?.order ?? 0;
      const courseB = LESSON_COURSES.find((course) => course.id === b.courseId)?.order ?? 0;
      return courseA - courseB || a.order - b.order;
    })
    .map((lesson) => ({
      lessonId: lesson.id,
      stepIndex: snapshot.lessons.stepIndexByLesson[lesson.id] ?? 0,
      totalSteps: lesson.steps.length,
    }));

  const next = recommendedLesson(lessonState);

  // A weakness needs the practice minimum as well as the per-skill minimum:
  // below it the report says "not enough data" instead of naming a skill.
  const insufficientData = practice.attempts < COACHING_THRESHOLDS.minPracticeAttempts;
  const reportedWeak = insufficientData
    ? []
    : findWeakSkills(skills).slice(0, COACHING_THRESHOLDS.maxWeakSkills);

  const recommendations: CoachingRecommendation[] = [];
  if (inProgress[0]) {
    recommendations.push({
      kind: "lesson",
      lessonId: inProgress[0].lessonId,
      skillId: lessonSkillId(inProgress[0].lessonId),
      reasonKey: "resumeLesson",
    });
  }

  if (!insufficientData) {
    for (const skill of reportedWeak.slice(0, COACHING_THRESHOLDS.maxPracticeRecommendations)) {
      const difficulty = recommendedDifficulty(skill.skillId);
      const exercise = difficulty ? practiceExercisesFor(skill.skillId, difficulty)[0] : null;
      if (!exercise) continue;
      recommendations.push({
        kind: "practice",
        skillId: skill.skillId,
        categoryId: skill.categoryId,
        exerciseId: exercise.id,
        difficulty: exercise.difficulty,
        reasonKey: weakReasonKey(skill),
      });
    }

    if (reportedWeak.length === 0) {
      const ready = findReadySkill(skills, snapshot);
      const readyStat = ready
        ? skills.find((skill) => skill.skillId === ready.skillId)
        : null;
      const exercise = ready
        ? practiceExercisesFor(ready.skillId, ready.difficulty)[0]
        : null;
      if (ready && readyStat && exercise) {
        recommendations.push({
          kind: "practice",
          skillId: ready.skillId,
          categoryId: readyStat.categoryId,
          exerciseId: exercise.id,
          difficulty: exercise.difficulty,
          reasonKey: "readyForNextLevel",
        });
      }
    }
  }

  // ── Training plan ───────────────────────────────────────────────────────
  const focus = reportedWeak[0] ?? null;
  const focusDifficulty = focus ? recommendedDifficulty(focus.skillId) : null;
  const focusLessonId = focus ? SKILL_LESSON_ID[focus.skillId] ?? null : null;
  const firstInProgress = inProgress[0]?.lessonId ?? null;

  let plan: CoachingPlan;
  if (!focus && !firstInProgress) {
    plan = {
      available: false,
      reasonKey: practice.attempts === 0 ? "noPracticeData" : "notEnoughData",
    };
  } else {
    const items: CoachingPlanItem[] = [];
    if (focus && focusDifficulty) {
      for (const exercise of practiceExercisesFor(focus.skillId, focusDifficulty).slice(0, 3)) {
        items.push({
          kind: "practice",
          exerciseId: exercise.id,
          skillId: focus.skillId,
          difficulty: exercise.difficulty,
          minutes: 3,
        });
      }
    }
    const planLessonId = firstInProgress ?? focusLessonId;
    if (planLessonId) items.push({ kind: "lesson", lessonId: planLessonId, minutes: 5 });

    plan = {
      available: true,
      reasonKey: focus ? "focusWeakSkill" : "resumeLesson",
      focusSkillId: focus?.skillId ?? null,
      focusCategoryId: focus?.categoryId ?? null,
      difficulty: focusDifficulty,
      lessonId: planLessonId,
      dailyMinutes: items.reduce((total, item) => total + item.minutes, 0) || 5,
      items,
    };
  }

  // ── History and comparison ──────────────────────────────────────────────
  const history = Object.entries(practice.history)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-COACHING_THRESHOLDS.historyDays)
    .map(([dayKeyValue, bucket]) => ({
      dayKey: dayKeyValue,
      attempts: bucket.attempts,
      completions: bucket.completions,
      hints: bucket.hints,
    }));

  const windowDays = COACHING_THRESHOLDS.comparisonWindowDays;
  const currentFrom = dayKey(shiftDays(now, -(windowDays - 1)));
  const previousFrom = dayKey(shiftDays(now, -(windowDays * 2 - 1)));
  const previousTo = dayKey(shiftDays(now, -windowDays));

  const current = sumHistory(practice.history, currentFrom, dayKey(now));
  const previous = sumHistory(practice.history, previousFrom, previousTo);
  const comparable =
    current.attempts >= COACHING_THRESHOLDS.comparisonMinAttempts &&
    previous.attempts >= COACHING_THRESHOLDS.comparisonMinAttempts;

  const comparison: CoachingReport["comparison"] = comparable
    ? {
        comparable: true,
        windowDays,
        current,
        previous,
        currentSuccessRate: successRate(current),
        previousSuccessRate: successRate(previous),
        delta: {
          attempts: current.attempts - previous.attempts,
          completions: current.completions - previous.completions,
          hints: current.hints - previous.hints,
          successRate: successRate(current) - successRate(previous),
        },
      }
    : { comparable: false, reasonKey: "notEnoughHistory" };

  const reasons: string[] = [];
  if (practice.attempts === 0) reasons.push("noPractice");
  else if (insufficientData) reasons.push("notEnoughPractice");
  if (history.length < 2) reasons.push("noHistory");

  return {
    generatedAt: now.toISOString(),
    thresholds: COACHING_THRESHOLDS,
    totals: {
      lessonsCompleted: completedLessonIds.size,
      lessonsAvailable: LESSON_CATALOG.length,
      coursesCompleted,
      coursesAvailable: LESSON_COURSES.length,
      practiceAttempts: practice.attempts,
      practiceCompletions: practice.completions,
      exercisesAttempted: Object.keys(practice.byExercise).length,
      exercisesCompleted: Object.values(practice.byExercise).filter(
        (bucket) => bucket.completions > 0,
      ).length,
      successRate: successRate({
        attempts: practice.attempts,
        completions: practice.completions,
        hints: practice.hints,
      }),
      hints: practice.hints,
    },
    lessons: {
      inProgress,
      completedLessonIds: [...completedLessonIds],
      nextLessonId: next?.id ?? null,
    },
    skills,
    difficulties,
    weakSkills: reportedWeak,
    history,
    comparison,
    recommendations,
    plan,
    insufficientData,
    reasons,
  };
}

/** Export for the UI's practice deep-links (skill query validation). */
export function isPracticeSkillId(value: unknown): value is string {
  return typeof value === "string" && Boolean(PRACTICE_SKILL_BY_ID[value]);
}
