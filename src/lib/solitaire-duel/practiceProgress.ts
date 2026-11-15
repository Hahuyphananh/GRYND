// src/lib/solitaire-duel/practiceProgress.ts
//
// LOCAL practice progress, kept deliberately separate from course progress.
//
//   * lessons record completion of authored courses (`lessonProgress.ts`);
//   * practice records drills: attempts, completions, hints, and the skill
//     category / difficulty they belong to.
//
// Nothing here is a competitive record. There is no Elo write, no trophy, no
// coin, no quest, no player level and no server call: the store is device-local
// for guests AND signed-in players, namespaced per account so two players on a
// shared browser never see each other's drills. Every id is checked against the
// VALIDATED practice catalog, so a stale storage payload from an older catalog
// can never invent an exercise or a skill.

import {
  PRACTICE_DIFFICULTIES,
  PRACTICE_SKILL_BY_ID,
  findPracticeExercise,
  type PracticeCategoryId,
  type PracticeDifficulty,
} from "./practice";

export type PracticeBucket = {
  readonly attempts: number;
  readonly completions: number;
  readonly hints: number;
};

export type PracticeProgressState = {
  readonly attempts: number;
  readonly completions: number;
  readonly hints: number;
  readonly byExercise: Readonly<Record<string, PracticeBucket>>;
  readonly bySkill: Readonly<Record<string, PracticeBucket>>;
  readonly byDifficulty: Readonly<Record<PracticeDifficulty, PracticeBucket>>;
  /**
   * Activity per UTC day (`YYYY-MM-DD`), for the Pro coaching history. It is
   * local-only and derived from the same events as the counters above, so a
   * cleared/blocked store simply has no history rather than invented history.
   */
  readonly history: Readonly<Record<string, PracticeBucket>>;
  readonly lastExerciseId: string | null;
  readonly updatedAt: number;
};

export type PracticeScope = {
  readonly exerciseId: string;
  readonly skillId: string;
  readonly difficulty: PracticeDifficulty;
};

export type PracticeStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export const PRACTICE_PROGRESS_STORAGE_PREFIX = "grynd:solitaire:practice:v1";
export const PRACTICE_PROGRESS_EVENT = "grynd:practice-progress";

/** A UTC day key, and the retention cap for the local history series. */
const PRACTICE_DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_HISTORY_DAYS = 400;

/** The UTC day a local event belongs to. */
export function practiceDayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

const EMPTY_BUCKET: PracticeBucket = Object.freeze({ attempts: 0, completions: 0, hints: 0 });

function emptyDifficultyBuckets(): Record<PracticeDifficulty, PracticeBucket> {
  return {
    beginner: { ...EMPTY_BUCKET },
    intermediate: { ...EMPTY_BUCKET },
    advanced: { ...EMPTY_BUCKET },
  };
}

export function emptyPracticeProgress(): PracticeProgressState {
  return {
    attempts: 0,
    completions: 0,
    hints: 0,
    byExercise: {},
    bySkill: {},
    byDifficulty: emptyDifficultyBuckets(),
    history: {},
    lastExerciseId: null,
    updatedAt: 0,
  };
}

export function practiceProgressStorageKey(userId?: string | null): string {
  return `${PRACTICE_PROGRESS_STORAGE_PREFIX}:${userId ? encodeURIComponent(userId) : "guest"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function bucketOf(value: unknown): PracticeBucket {
  if (!isRecord(value)) return { ...EMPTY_BUCKET };
  return {
    attempts: count(value.attempts),
    completions: count(value.completions),
    hints: count(value.hints),
  };
}

function addBucket(bucket: PracticeBucket, patch: Partial<PracticeBucket>): PracticeBucket {
  return {
    attempts: bucket.attempts + (patch.attempts ?? 0),
    completions: bucket.completions + (patch.completions ?? 0),
    hints: bucket.hints + (patch.hints ?? 0),
  };
}

/** Accept only exercises and skills that still exist, and finite counts. */
export function normalizePracticeProgress(value: unknown): PracticeProgressState {
  if (!isRecord(value)) return emptyPracticeProgress();

  const byExercise: Record<string, PracticeBucket> = {};
  if (isRecord(value.byExercise)) {
    for (const [id, raw] of Object.entries(value.byExercise)) {
      if (!findPracticeExercise(id)) continue;
      byExercise[id] = bucketOf(raw);
    }
  }

  const bySkill: Record<string, PracticeBucket> = {};
  if (isRecord(value.bySkill)) {
    for (const [id, raw] of Object.entries(value.bySkill)) {
      if (!PRACTICE_SKILL_BY_ID[id]) continue;
      bySkill[id] = bucketOf(raw);
    }
  }

  const byDifficulty = emptyDifficultyBuckets();
  if (isRecord(value.byDifficulty)) {
    for (const difficulty of PRACTICE_DIFFICULTIES) {
      byDifficulty[difficulty] = bucketOf(value.byDifficulty[difficulty]);
    }
  }

  const history: Record<string, PracticeBucket> = {};
  if (isRecord(value.history)) {
    const days = Object.keys(value.history)
      .filter((day) => PRACTICE_DAY_KEY.test(day))
      .sort()
      .slice(-MAX_HISTORY_DAYS);
    for (const day of days) history[day] = bucketOf(value.history[day]);
  }

  const lastExerciseId =
    typeof value.lastExerciseId === "string" && findPracticeExercise(value.lastExerciseId)
      ? value.lastExerciseId
      : null;

  return {
    attempts: count(value.attempts),
    completions: count(value.completions),
    hints: count(value.hints),
    byExercise,
    bySkill,
    byDifficulty,
    history,
    lastExerciseId,
    updatedAt: count(value.updatedAt),
  };
}

export function parsePracticeProgress(raw: string | null): PracticeProgressState {
  if (!raw) return emptyPracticeProgress();
  try {
    return normalizePracticeProgress(JSON.parse(raw));
  } catch {
    return emptyPracticeProgress();
  }
}

export function serializePracticeProgress(progress: PracticeProgressState): string {
  return JSON.stringify(progress);
}

export function readPracticeProgress(
  storage: PracticeStorage | null | undefined,
  userId?: string | null,
): PracticeProgressState {
  if (!storage) return emptyPracticeProgress();
  try {
    return parsePracticeProgress(storage.getItem(practiceProgressStorageKey(userId)));
  } catch {
    return emptyPracticeProgress();
  }
}

export function writePracticeProgress(
  storage: PracticeStorage | null | undefined,
  userId: string | null | undefined,
  progress: PracticeProgressState,
): void {
  if (!storage) return;
  try {
    storage.setItem(practiceProgressStorageKey(userId), serializePracticeProgress(progress));
  } catch {
    // Private mode / blocked storage: the drill still runs in memory.
  }
}

/**
 * A scope is trusted only when the exercise id exists AND agrees with the skill
 * and difficulty the caller passed. A mismatched scope is ignored, so a bug or
 * forged argument cannot file a drill under the wrong skill.
 */
function isKnownScope(scope: PracticeScope): boolean {
  const exercise = findPracticeExercise(scope.exerciseId);
  return Boolean(
    exercise &&
      exercise.skillId === scope.skillId &&
      exercise.difficulty === scope.difficulty,
  );
}

function withEvent(
  progress: PracticeProgressState,
  scope: PracticeScope,
  patch: Partial<PracticeBucket>,
  now: number,
): PracticeProgressState {
  return {
    ...progress,
    attempts: progress.attempts + (patch.attempts ?? 0),
    completions: progress.completions + (patch.completions ?? 0),
    hints: progress.hints + (patch.hints ?? 0),
    byExercise: {
      ...progress.byExercise,
      [scope.exerciseId]: addBucket(
        progress.byExercise[scope.exerciseId] ?? EMPTY_BUCKET,
        patch,
      ),
    },
    bySkill: {
      ...progress.bySkill,
      [scope.skillId]: addBucket(progress.bySkill[scope.skillId] ?? EMPTY_BUCKET, patch),
    },
    byDifficulty: {
      ...progress.byDifficulty,
      [scope.difficulty]: addBucket(progress.byDifficulty[scope.difficulty], patch),
    },
    history: {
      ...progress.history,
      [practiceDayKey(now)]: addBucket(progress.history[practiceDayKey(now)] ?? EMPTY_BUCKET, patch),
    },
    lastExerciseId: scope.exerciseId,
    updatedAt: now,
  };
}

/** A new attempt, counted when the drill is started or restarted. */
export function recordPracticeAttempt(
  progress: PracticeProgressState,
  scope: PracticeScope,
  now = Date.now(),
): PracticeProgressState {
  if (!isKnownScope(scope)) return progress;
  return withEvent(progress, scope, { attempts: 1 }, now);
}

/** One revealed hint. Hints stay counted after a restart (they happened). */
export function recordPracticeHint(
  progress: PracticeProgressState,
  scope: PracticeScope,
  now = Date.now(),
): PracticeProgressState {
  if (!isKnownScope(scope)) return progress;
  return withEvent(progress, scope, { hints: 1 }, now);
}

/** One completion. Repeating a drill counts again, as an attempt and a win. */
export function recordPracticeCompletion(
  progress: PracticeProgressState,
  scope: PracticeScope,
  now = Date.now(),
): PracticeProgressState {
  if (!isKnownScope(scope)) return progress;
  return withEvent(progress, scope, { completions: 1 }, now);
}

export type PracticeCategoryStat = {
  readonly attempts: number;
  readonly completions: number;
  readonly hints: number;
};

export type PracticeStats = {
  readonly attempts: number;
  readonly completions: number;
  /** completed / attempted, as a whole percent. 0 when nothing was attempted. */
  readonly successRate: number;
  readonly hints: number;
  /** Distinct exercises attempted / completed. */
  readonly exercisesAttempted: number;
  readonly exercisesCompleted: number;
  readonly byCategory: Record<PracticeCategoryId, PracticeCategoryStat>;
  readonly byDifficulty: Record<PracticeDifficulty, PracticeCategoryStat>;
};

/** The summary the Practice page renders. Derived, never stored twice. */
export function practiceStats(progress: PracticeProgressState): PracticeStats {
  const byCategory: Record<PracticeCategoryId, PracticeCategoryStat> = {
    tableau: { attempts: 0, completions: 0, hints: 0 },
    foundations: { attempts: 0, completions: 0, hints: 0 },
    "stock-and-waste": { attempts: 0, completions: 0, hints: 0 },
    strategy: { attempts: 0, completions: 0, hints: 0 },
  };

  for (const [skillId, bucket] of Object.entries(progress.bySkill)) {
    const skill = PRACTICE_SKILL_BY_ID[skillId];
    if (!skill) continue;
    const stat = byCategory[skill.categoryId];
    byCategory[skill.categoryId] = {
      attempts: stat.attempts + bucket.attempts,
      completions: stat.completions + bucket.completions,
      hints: stat.hints + bucket.hints,
    };
  }

  const byDifficulty: Record<PracticeDifficulty, PracticeCategoryStat> = {
    beginner: { ...progress.byDifficulty.beginner },
    intermediate: { ...progress.byDifficulty.intermediate },
    advanced: { ...progress.byDifficulty.advanced },
  };

  const exercises = Object.values(progress.byExercise);

  return {
    attempts: progress.attempts,
    completions: progress.completions,
    successRate:
      progress.attempts > 0
        ? Math.round((progress.completions / progress.attempts) * 100)
        : 0,
    hints: progress.hints,
    exercisesAttempted: exercises.filter((bucket) => bucket.attempts > 0).length,
    exercisesCompleted: exercises.filter((bucket) => bucket.completions > 0).length,
    byCategory,
    byDifficulty,
  };
}

export function notifyPracticeProgressChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PRACTICE_PROGRESS_EVENT));
}
