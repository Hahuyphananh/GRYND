"use client";

// Reads and writes the device-local strategic-puzzle record for the current
// account, following the shipped lesson/practice hooks exactly: guests use a
// `guest` key, signed-in players use their Clerk id, storage events keep tabs in
// step, and blocked storage degrades to in-memory progress.
//
// The hook receives the player puzzles (a solution-free projection) and supplies
// their ids to the store for validation. It deliberately never imports the
// library builder or its data, so no accepted answer path is bundled for the
// browser.
//
// No request is made here. The strategic library is not a competitive record and
// is never sent to a server.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useUser } from "@clerk/nextjs";

import {
  PUZZLE_PROGRESS_EVENT,
  emptyPuzzleProgress,
  readPuzzleProgress,
  recordPuzzleCompletion,
  recordPuzzleStart,
  writePuzzleProgress,
  type PuzzleProgressState,
} from "../lib/solitaire-duel/puzzleProgress";

type ProgressPuzzle = { id: string; spec: { version: number } };

export function usePuzzleProgress(puzzles: readonly ProgressPuzzle[]) {
  const { isLoaded, user } = useUser();
  const userId = isLoaded ? user?.id ?? null : null;
  const knownIds = useMemo(() => puzzles.map((puzzle) => puzzle.id), [puzzles]);
  const [progress, setProgress] = useState<PuzzleProgressState>(emptyPuzzleProgress);
  const [isProgressLoaded, setIsProgressLoaded] = useState(false);

  useEffect(() => {
    const sync = () => {
      const storage = typeof window === "undefined" ? null : window.localStorage;
      setProgress(readPuzzleProgress(storage, userId, knownIds));
      setIsProgressLoaded(true);
    };
    sync();
    if (typeof window === "undefined") return undefined;

    window.addEventListener("storage", sync);
    window.addEventListener(PUZZLE_PROGRESS_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(PUZZLE_PROGRESS_EVENT, sync);
    };
  }, [userId, knownIds]);

  const commit = useCallback(
    (next: PuzzleProgressState) => {
      const storage = typeof window === "undefined" ? null : window.localStorage;
      writePuzzleProgress(storage, userId, next);
      setProgress(next);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(PUZZLE_PROGRESS_EVENT));
      }
    },
    [userId],
  );

  /** A started (or restarted) attempt. Never clears an earlier completion. */
  const startPuzzle = useCallback(
    (puzzle: ProgressPuzzle) =>
      commit(
        recordPuzzleStart(
          progress,
          { id: puzzle.id, version: puzzle.spec.version, knownIds },
        ),
      ),
    [commit, progress, knownIds],
  );

  /** A completed line; the store keeps the best moves/hints pair. */
  const completePuzzle = useCallback(
    (puzzle: ProgressPuzzle, moves: number, hints: number) =>
      commit(
        recordPuzzleCompletion(progress, {
          id: puzzle.id,
          version: puzzle.spec.version,
          moves,
          hints,
          knownIds,
        }),
      ),
    [commit, progress, knownIds],
  );

  return { progress, userId, isProgressLoaded, startPuzzle, completePuzzle };
}
