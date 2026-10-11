"use client";

import { useEffect, useRef } from "react";
import {
  DEADLINE_READ_MAX_ATTEMPTS,
  DEADLINE_READ_RETRY_MS,
  deadlineReadDelayMs,
  type StampedInstant,
} from "../lib/deadlineRead";

/**
 * The ONE authoritative read a stored deadline needs — the shared implementation
 * of the timing rule described in `lib/deadlineRead.ts`.
 *
 * Clocked matches advance at absolute instants the server stamped, and the only
 * thing that turns an instant into a transition is a read of the match route
 * (`fetchMatchWithAutoResolve`, `advanceMatchOnPoll`, `game-state`). The match
 * pages no longer poll, so an instant nobody reads past simply runs out: both
 * players sit on a finished countdown and the game never starts, a stalling
 * opponent is never timed out, an expired race is never graded.
 *
 * This is deliberately NOT a recurring poll:
 *
 *   * it arms ONE timer, for the single instant `deadline` names;
 *   * it exists only while that instant does — when the match advances (or the
 *     turn changes, or the race resolves) the caller passes `null` and the timer
 *     is cleared with the effect;
 *   * every read it makes goes through the caller's own authoritative fetch, the
 *     same one a socket push triggers; and
 *   * it gives up after `DEADLINE_READ_MAX_ATTEMPTS` reads, so a deadline that
 *     cannot be advanced costs a handful of requests and stops.
 *
 * The read is a beat LATE on purpose (the stores advance only once the deadline
 * has passed) and is retried, so a device clock skewed ahead of the server's or
 * a throttled background tab cannot leave the match sitting on it.
 *
 *   // Which instant the game is waiting on lives in `lib/deadlineRead.ts`.
 *   useDeadlineRead(fourInARowDueRead(game), fetchState);
 *
 * `read` is held in a ref so an inline arrow function (a new identity every
 * render) does not tear the timer down and re-arm it on each paint — only a
 * change of `deadline` does that.
 */
export function useDeadlineRead(
  deadline: StampedInstant,
  read: () => void | Promise<void>,
): void {
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  });

  useEffect(() => {
    if (!deadline) return undefined;
    const at = new Date(deadline).getTime();
    if (!Number.isFinite(at)) return undefined;
    let reads = 0;
    let timer = 0;
    const run = () => {
      reads += 1;
      void readRef.current();
      if (reads < DEADLINE_READ_MAX_ATTEMPTS) {
        timer = window.setTimeout(run, DEADLINE_READ_RETRY_MS);
      }
    };
    timer = window.setTimeout(run, deadlineReadDelayMs(at, Date.now()));
    return () => window.clearTimeout(timer);
  }, [deadline]);
}
