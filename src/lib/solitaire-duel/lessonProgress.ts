// src/lib/solitaire-duel/lessonProgress.ts
//
// LOCAL lesson progress. The lesson engine intentionally has no storage or
// server dependency, so the Learn section keeps a small, honest record of what
// this browser has completed:
//
//   * completed lesson ids (a set for fast course/lesson status),
//   * the furthest step reached in each unfinished lesson,
//   * the last lesson opened (for Continue Learning).
//
// It is device-local for guests AND signed-in players. No ranked result, trophy,
// coin, Elo or matchmaking record is written, and no lesson completion is sent
// to the server. The storage key is namespaced per account so two players on a
// shared browser do not see each other's lesson progress.

import {
  LESSON_BY_ID,
  LESSON_CATALOG,
  LESSON_COURSES,
  lessonsForCourse,
} from "./lessonCatalog";
import type { Lesson, LessonDifficulty } from "./lessons";

export type LessonProgressState = {
  readonly completedLessonIds: readonly string[];
  readonly stepIndexByLesson: Readonly<Record<string, number>>;
  readonly lastLessonId: string | null;
  readonly updatedAt: number;
};

export type LessonProgressUpdate = {
  readonly lessonId: string;
  readonly stepIndex: number;
  readonly completed?: boolean;
};

export type LessonStatus = "not-started" | "in-progress" | "completed";
export type CourseState = "locked" | "available" | "completed";

export type ProgressStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export const LESSON_PROGRESS_STORAGE_PREFIX = "grynd:solitaire:learn:v1";
export const LESSON_PROGRESS_EVENT = "grynd:lesson-progress";

const EMPTY_STATE: LessonProgressState = {
  completedLessonIds: [],
  stepIndexByLesson: {},
  lastLessonId: null,
  updatedAt: 0,
};

export function emptyLessonProgress(): LessonProgressState {
  return { ...EMPTY_STATE, stepIndexByLesson: {} };
}

export function lessonProgressStorageKey(userId?: string | null): string {
  return `${LESSON_PROGRESS_STORAGE_PREFIX}:${userId ? encodeURIComponent(userId) : "guest"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Accept only lessons that still exist in the authored catalog, a finite
 * non-negative step index, and a last lesson id that is real. A stale storage
 * payload from an older catalog can never make the UI claim a lesson exists.
 */
export function normalizeLessonProgress(value: unknown): LessonProgressState {
  if (!isRecord(value)) return emptyLessonProgress();

  const completed = Array.isArray(value.completedLessonIds)
    ? [...new Set(
        value.completedLessonIds.filter(
          (id): id is string => typeof id === "string" && Boolean(LESSON_BY_ID[id]),
        ),
      )]
    : [];

  const steps: Record<string, number> = {};
  if (isRecord(value.stepIndexByLesson)) {
    for (const [id, raw] of Object.entries(value.stepIndexByLesson)) {
      if (!LESSON_BY_ID[id] || typeof raw !== "number" || !Number.isFinite(raw)) continue;
      steps[id] = Math.max(0, Math.floor(raw));
    }
  }

  const lastLessonId =
    typeof value.lastLessonId === "string" && LESSON_BY_ID[value.lastLessonId]
      ? value.lastLessonId
      : null;

  return {
    completedLessonIds: completed,
    stepIndexByLesson: steps,
    lastLessonId,
    updatedAt:
      typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : 0,
  };
}

export function parseLessonProgress(raw: string | null): LessonProgressState {
  if (!raw) return emptyLessonProgress();
  try {
    return normalizeLessonProgress(JSON.parse(raw));
  } catch {
    return emptyLessonProgress();
  }
}

export function serializeLessonProgress(progress: LessonProgressState): string {
  return JSON.stringify(progress);
}

export function readLessonProgress(
  storage: ProgressStorage | null | undefined,
  userId?: string | null,
): LessonProgressState {
  if (!storage) return emptyLessonProgress();
  try {
    return parseLessonProgress(storage.getItem(lessonProgressStorageKey(userId)));
  } catch {
    return emptyLessonProgress();
  }
}

export function writeLessonProgress(
  storage: ProgressStorage | null | undefined,
  userId: string | null | undefined,
  progress: LessonProgressState,
): void {
  if (!storage) return;
  try {
    storage.setItem(lessonProgressStorageKey(userId), serializeLessonProgress(progress));
  } catch {
    // Private mode / blocked storage: lessons still work in memory.
  }
}

export function isLessonCompleted(
  progress: LessonProgressState,
  lessonId: string,
): boolean {
  return progress.completedLessonIds.includes(lessonId);
}

/** Furthest step reached, clamped to the lesson and completed at its total. */
export function lessonStepIndex(progress: LessonProgressState, lesson: Lesson): number {
  if (isLessonCompleted(progress, lesson.id)) return lesson.steps.length;
  const raw = progress.stepIndexByLesson[lesson.id] ?? 0;
  return Math.min(Math.max(0, Math.floor(raw)), lesson.steps.length);
}

export function lessonStatus(
  progress: LessonProgressState,
  lesson: Lesson,
): LessonStatus {
  if (isLessonCompleted(progress, lesson.id)) return "completed";
  return lessonStepIndex(progress, lesson) > 0 ? "in-progress" : "not-started";
}

export function recordLessonProgress(
  progress: LessonProgressState,
  update: LessonProgressUpdate,
  now = Date.now(),
): LessonProgressState {
  if (!LESSON_BY_ID[update.lessonId]) return progress;

  const lesson = LESSON_BY_ID[update.lessonId];
  const stepIndex = Math.min(
    Math.max(0, Math.floor(Number.isFinite(update.stepIndex) ? update.stepIndex : 0)),
    lesson.steps.length,
  );
  const alreadyComplete = isLessonCompleted(progress, update.lessonId);
  const completed = update.completed === true || alreadyComplete;

  return {
    completedLessonIds: completed
      ? [...new Set([...progress.completedLessonIds, update.lessonId])]
      : progress.completedLessonIds.filter((id) => id !== update.lessonId),
    stepIndexByLesson: {
      ...progress.stepIndexByLesson,
      [update.lessonId]: completed ? lesson.steps.length : stepIndex,
    },
    lastLessonId: update.lessonId,
    updatedAt: now,
  };
}

export function orderedCourses() {
  return [...LESSON_COURSES].sort((a, b) => a.order - b.order);
}

export function orderedLessons(): readonly Lesson[] {
  return orderedCourses().flatMap((course) => lessonsForCourse(course.id));
}

export function isCourseComplete(
  progress: LessonProgressState,
  courseId: string,
): boolean {
  const lessons = lessonsForCourse(courseId);
  return lessons.length > 0 && lessons.every((lesson) => isLessonCompleted(progress, lesson.id));
}

/**
 * A course is locked only while a previous course is unfinished. The first
 * course is always available, and a completed course stays open for review.
 */
export function courseState(
  progress: LessonProgressState,
  courseId: string,
): CourseState {
  const courses = orderedCourses();
  const index = courses.findIndex((course) => course.id === courseId);
  if (index < 0) return "locked";
  if (isCourseComplete(progress, courseId)) return "completed";
  const previous = courses.slice(0, index);
  return previous.every((course) => isCourseComplete(progress, course.id))
    ? "available"
    : "locked";
}

export function courseProgress(
  progress: LessonProgressState,
  courseId: string,
): { completed: number; total: number } {
  const lessons = lessonsForCourse(courseId);
  return {
    completed: lessons.filter((lesson) => isLessonCompleted(progress, lesson.id)).length,
    total: lessons.length,
  };
}

export function overallProgress(progress: LessonProgressState): {
  completedLessons: number;
  totalLessons: number;
  completedSteps: number;
  totalSteps: number;
  percent: number;
} {
  let completedLessons = 0;
  let completedSteps = 0;
  let totalSteps = 0;
  for (const lesson of orderedLessons()) {
    totalSteps += lesson.steps.length;
    if (isLessonCompleted(progress, lesson.id)) {
      completedLessons += 1;
      completedSteps += lesson.steps.length;
    } else {
      completedSteps += lessonStepIndex(progress, lesson);
    }
  }
  return {
    completedLessons,
    totalLessons: LESSON_CATALOG.length,
    completedSteps,
    totalSteps,
    percent: totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0,
  };
}

/**
 * The next lesson to recommend: the first unfinished lesson in the first
 * unlocked course. A completed course's lessons stay reviewable, but they are
 * never the recommendation while a later course is open.
 */
export function recommendedLesson(progress: LessonProgressState): Lesson | null {
  for (const course of orderedCourses()) {
    if (courseState(progress, course.id) === "locked") break;
    const next = lessonsForCourse(course.id).find(
      (lesson) => !isLessonCompleted(progress, lesson.id),
    );
    if (next) return next;
  }
  return null;
}

export function courseDifficulty(courseId: string): LessonDifficulty {
  const rank: Record<LessonDifficulty, number> = {
    beginner: 0,
    intermediate: 1,
    advanced: 2,
  };
  return lessonsForCourse(courseId).reduce<LessonDifficulty>(
    (highest, lesson) => (rank[lesson.difficulty] > rank[highest] ? lesson.difficulty : highest),
    "beginner",
  );
}

/** The next lesson in reading order, across course boundaries. */
export function nextLessonAfter(lessonId: string): Lesson | null {
  const lessons = orderedLessons();
  const index = lessons.findIndex((lesson) => lesson.id === lessonId);
  return index >= 0 ? lessons[index + 1] ?? null : null;
}

export function notifyLessonProgressChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(LESSON_PROGRESS_EVENT));
}
