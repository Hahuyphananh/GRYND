"use client";

import { useCallback, useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";

import {
  PRACTICE_PROGRESS_EVENT,
  emptyPracticeProgress,
  notifyPracticeProgressChanged,
  readPracticeProgress,
  recordPracticeAttempt,
  recordPracticeCompletion,
  recordPracticeHint,
  writePracticeProgress,
  type PracticeProgressState,
  type PracticeScope,
} from "../lib/solitaire-duel/practiceProgress";

/**
 * Reads and writes the device-local practice record for the current account.
 *
 * Guests use a `guest` key and signed-in players use their Clerk id, exactly as
 * the lesson hook does. No request is made: practice is never sent to a server
 * and never touches a competitive record. Blocked storage degrades to in-memory
 * progress for the session.
 */
export function usePracticeProgress() {
  const { isLoaded, user } = useUser();
  const userId = isLoaded ? user?.id ?? null : null;
  const [progress, setProgress] = useState<PracticeProgressState>(emptyPracticeProgress);
  const [isProgressLoaded, setIsProgressLoaded] = useState(false);

  useEffect(() => {
    const sync = () => {
      const storage = typeof window === "undefined" ? null : window.localStorage;
      setProgress(readPracticeProgress(storage, userId));
      setIsProgressLoaded(true);
    };
    sync();
    if (typeof window === "undefined") return undefined;
    window.addEventListener("storage", sync);
    window.addEventListener(PRACTICE_PROGRESS_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(PRACTICE_PROGRESS_EVENT, sync);
    };
  }, [userId]);

  const commit = useCallback(
    (next: PracticeProgressState) => {
      const storage = typeof window === "undefined" ? null : window.localStorage;
      writePracticeProgress(storage, userId, next);
      setProgress(next);
      notifyPracticeProgressChanged();
    },
    [userId],
  );

  const startAttempt = useCallback(
    (scope: PracticeScope) => commit(recordPracticeAttempt(progress, scope)),
    [commit, progress],
  );

  const useHint = useCallback(
    (scope: PracticeScope) => commit(recordPracticeHint(progress, scope)),
    [commit, progress],
  );

  const completeAttempt = useCallback(
    (scope: PracticeScope) => commit(recordPracticeCompletion(progress, scope)),
    [commit, progress],
  );

  return {
    progress,
    userId,
    isLoaded,
    isProgressLoaded,
    startAttempt,
    useHint,
    completeAttempt,
  };
}
