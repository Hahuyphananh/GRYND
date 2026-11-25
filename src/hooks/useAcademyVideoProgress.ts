"use client";

import { useCallback, useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";

import {
  ACADEMY_VIDEO_PROGRESS_EVENT,
  emptyAcademyVideoProgress,
  notifyAcademyVideoProgressChanged,
  readAcademyVideoProgress,
  recordAcademyVideoProgress,
  writeAcademyVideoProgress,
  type AcademyVideoProgressState,
} from "../lib/academyVideoProgress";

/**
 * Reads and writes the device-local video record for the current account.
 *
 * Guests use a `guest` key; a signed-in player uses their Clerk id. Mirrors
 * useLessonProgress, including the storage event so two tabs stay in sync.
 */
export function useAcademyVideoProgress() {
  const { isLoaded, user } = useUser();
  const userId = isLoaded ? user?.id ?? null : null;
  const [progress, setProgress] = useState<AcademyVideoProgressState>(
    emptyAcademyVideoProgress,
  );
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    const sync = () => {
      const storage = typeof window === "undefined" ? null : window.localStorage;
      setProgress(readAcademyVideoProgress(storage, userId));
      setIsHydrated(true);
    };
    sync();
    if (typeof window === "undefined") return undefined;
    window.addEventListener("storage", sync);
    window.addEventListener(ACADEMY_VIDEO_PROGRESS_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(ACADEMY_VIDEO_PROGRESS_EVENT, sync);
    };
  }, [userId]);

  const update = useCallback(
    (videoId: string, position: number, watched = false) => {
      const next = recordAcademyVideoProgress(progress, {
        videoId,
        position,
        watched,
      });
      const storage = typeof window === "undefined" ? null : window.localStorage;
      writeAcademyVideoProgress(storage, userId, next);
      setProgress(next);
      notifyAcademyVideoProgressChanged();
    },
    [progress, userId],
  );

  const recordPosition = useCallback(
    (videoId: string, position: number) => update(videoId, position, false),
    [update],
  );

  const markWatched = useCallback(
    (videoId: string, position: number) => update(videoId, position, true),
    [update],
  );

  return { progress, userId, isLoaded, isHydrated, recordPosition, markWatched };
}
