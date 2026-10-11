"use client";

import { useEffect, useRef } from "react";
import {
  DEADLINE_READ_ANCHORED_SLACK_MS,
  DEADLINE_READ_MAX_ATTEMPTS,
  DEADLINE_READ_RETRY_MS,
  DEADLINE_READ_SLACK_MS,
  deadlineReadDelayMs,
  type StampedInstant,
} from "../lib/deadlineRead";

/** Options for `useDeadlineRead`. */
export interface DeadlineReadOptions {
  /**
   * How many reads to make for this deadline, including the first. Defaults to
   * `DEADLINE_READ_MAX_ATTEMPTS`.
   *
   * A caller whose deadline is an EVENT rather than a stamped instant —
   * Precision's "our own STOP is pending, so the result is one read away" — has
   * no natural instant to count down to, so it arms with "now" and wants only
   * enough attempts to survive a lost socket broadcast, not a whole window of
   * dead air while a human opponent takes their time. Lower it there; leave it
   * alone for the games whose deadline is a real stored instant.
   */
  attempts?: number;
  /**
   * Gap between those reads. Defaults to `DEADLINE_READ_RETRY_MS`.
   */
  retryMs?: number;
  /**
   * The current time in the SERVER's clock, as this device best knows it — or
   * `null`/`undefined` while this page has no estimate yet.
   *
   * Every match page that carries an estimate already has this: the poll's own
   * round trip yields `serverNow = Date.now() + offset`, and a page with none can
   * take one from `useServerClockEstimate`. Supplying it lets the read be armed in
   * server time, which is what lets the timer fire ON the stamped instant instead
   * of a slack `DEADLINE_READ_SLACK_MS` past it: the slack exists to cover the
   * DEVICE's clock skew, and an anchored clock has already had that skew removed.
   *
   * A null answer MUST stay null rather than fall back to `Date.now()`: a device
   * clock with no estimate is exactly the case the big slack exists for, so
   * "not yet sampled" has to mean "use the conservative slack", never "assume
   * the device clock is the server clock".
   */
  serverNow?: () => number | null | undefined;
}

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
 * a throttled background tab cannot leave the match sitting on it. Pass
 * `serverNow` to make that beat as short as it safely can be.
 *
 *   // Which instant the game is waiting on lives in `lib/deadlineRead.ts`.
 *   useDeadlineRead(fourInARowDueRead(game), fetchState);
 *   useDeadlineRead(kenoPvpDueRead(match), fetchStatus, {
 *     serverNow: () => Date.now() + clockOffset,
 *   });
 *
 * `read` is held in a ref so an inline arrow function (a new identity every
 * render) does not tear the timer down and re-arm it on each paint — only a
 * change of `deadline` does that.
 */
export function useDeadlineRead(
  deadline: StampedInstant,
  read: () => void | Promise<void>,
  options?: DeadlineReadOptions,
): void {
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  });

  // Ref-held for the same reason as `read`: the page passes an inline object, and
  // re-arming the timer whenever its identity changed would let a re-render move
  // the read. The clock is read when the timer is ARMED, so the ref carries the
  // freshest estimate the page had on that render — and an estimate that lands
  // after the arm applies to the NEXT one rather than moving a read already
  // scheduled. That is the safe direction: the first countdown after a mount
  // falls back to the conservative slack, which is exactly today's behaviour.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    if (!deadline) return undefined;
    const at = new Date(deadline).getTime();
    if (!Number.isFinite(at)) return undefined;
    // Bounded by construction: a caller that names a smaller budget (an
    // event-shaped deadline) cannot make this loop unbounded, because a
    // non-finite or sub-1 value falls back to the shared cap rather than to
    // "forever".
    const rawAttempts = optionsRef.current?.attempts;
    const attempts =
      typeof rawAttempts === "number" && Number.isFinite(rawAttempts) && rawAttempts >= 1
        ? Math.floor(rawAttempts)
        : DEADLINE_READ_MAX_ATTEMPTS;
    const rawRetry = optionsRef.current?.retryMs;
    const retryMs =
      typeof rawRetry === "number" && Number.isFinite(rawRetry) && rawRetry > 0
        ? rawRetry
        : DEADLINE_READ_RETRY_MS;
    let reads = 0;
    let timer = 0;
    const run = () => {
      reads += 1;
      void readRef.current();
      if (reads < attempts) {
        timer = window.setTimeout(run, retryMs);
      }
    };
    // Server-anchored when the page can express "now" in the server's clock, so
    // the timer lands ON the stamped instant; otherwise the conservative slack.
    const serverNow = optionsRef.current?.serverNow;
    let anchoredNow = NaN;
    if (typeof serverNow === "function") {
      try {
        anchoredNow = Number(serverNow());
      } catch {
        anchoredNow = NaN;
      }
    }
    const anchored = Number.isFinite(anchoredNow);
    const delay = anchored
      ? deadlineReadDelayMs(at, anchoredNow, DEADLINE_READ_ANCHORED_SLACK_MS)
      : deadlineReadDelayMs(at, Date.now(), DEADLINE_READ_SLACK_MS);
    timer = window.setTimeout(run, delay);
    return () => window.clearTimeout(timer);
  }, [deadline]);
}
