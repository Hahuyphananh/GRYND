"use client";

// src/hooks/useTurnCountdown.ts
//
// A VISUAL countdown for one server-stamped instant.
//
// This hook exists for exactly one job: make the fifteen-second turn window on
// screen tick. It is deliberately NOT the thing that resolves a turn.
//
//   * the instant is the server's (`turnDeadlineAt` from the authoritative
//     snapshot), never a client guess and never a duration the client chose;
//   * the ENFORCEMENT is the server's. A move that arrives after the deadline is
//     refused (`409`) and the clock acts for that seat inside the same row-locked
//     transaction, so this hook reaching zero can never decide a match;
//   * the client therefore never fabricates a draw, a pass or a forfeit. When the
//     deadline passes, the page arms ONE bounded read through `useDeadlineRead`
//     (src/hooks/useDeadlineRead.ts) so the SERVER's resolver runs, and the board
//     renders whatever that read returns.
//
// It stops ticking the moment the deadline passes (nothing left to count), and
// while the tab is hidden (a backgrounded tab cannot act), resuming with a fresh
// reading when it comes back.

import { useEffect, useState } from "react";

/** How often the displayed second is recomputed. Cheap: one state update. */
const DEFAULT_TICK_MS = 250;

/**
 * The current time, ticking only while a deadline is still in the future.
 *
 * Returns a `nowMs` the caller feeds to `countdownFor(deadlineAt, nowMs)`, so the
 * formatting stays in the pure view-model and this hook stays a clock.
 */
export function useTurnCountdown(
  deadlineAt: string | number | Date | null | undefined,
  tickMs: number = DEFAULT_TICK_MS,
): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    // A new turn (or a resolved clock) invalidates the previous reading.
    setNowMs(Date.now());
    if (!deadlineAt) return undefined;

    const deadline = new Date(deadlineAt as string).getTime();
    if (!Number.isFinite(deadline)) return undefined;

    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const start = () => {
      if (timer !== null) return;
      timer = setInterval(() => {
        const next = Date.now();
        setNowMs(next);
        // Nothing left to count: the server's read is what happens next.
        if (next >= deadline) stop();
      }, Math.max(50, tickMs));
    };

    const onVisibilityChange = () => {
      if (typeof document !== "undefined" && document.hidden) {
        stop();
        return;
      }
      // Catch up by one reading, then keep ticking if there is time left.
      const next = Date.now();
      setNowMs(next);
      if (next < deadline) start();
    };

    if (typeof document === "undefined" || !document.hidden) start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [deadlineAt, tickMs]);

  return nowMs;
}

export default useTurnCountdown;
