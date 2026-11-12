"use client";

import { useCallback, useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";

import {
  LESSON_PROGRESS_EVENT,
  emptyLessonProgress,
  notifyLessonProgressChanged,
  readLessonProgress,
  recordLessonProgress,
  writeLessonProgress,
  type LessonProgressState,
} from "../lib/solitaire-duel/lessonProgress";

/**
 * Reads and writes the device-local lesson record for the current account.
 *
 * Guests use a `guest` key; a signed-in player uses their Clerk id. The hook
 * never talks to a server, and a blocked/full localStorage degrades to
 * in-memory progress for the session.
 */
export function useLessonProgress() {
  const { isLoaded, user } = useUser();
  const userId = isLoaded ? user?.id ?? null : null;
  const [progress, setProgress] = useState<LessonProgressState>(emptyLessonProgress);

  useEffect(() => {
    const sync = () => {
      const storage = typeof window === "undefined" ? null : window.localStorage;
      setProgress(readLessonProgress(storage, userId));
    };
    sync();
    if (typeof window === "undefined") return undefined;
    window.addEventListener("storage", sync);
    window.addEventListener(LESSON_PROGRESS_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(LESSON_PROGRESS_EVENT, sync);
    };
  }, [userId]);

  const update = useCallback(
    (lessonId: string, stepIndex: number, completed = false) => {
      const next = recordLessonProgress(progress, { lessonId, stepIndex, completed });
      const storage = typeof window === "undefined" ? null : window.localStorage;
      writeLessonProgress(storage, userId, next);
      setProgress(next);
      notifyLessonProgressChanged();
    },
    [progress, userId],
  );

  const recordStep = useCallback(
    (lessonId: string, stepIndex: number) => update(lessonId, stepIndex, false),
    [update],
  );

  const completeLesson = useCallback(
    (lessonId: string, totalSteps: number) => update(lessonId, totalSteps, true),
    [update],
  );

  return { progress, userId, isLoaded, recordStep, completeLesson };
}
