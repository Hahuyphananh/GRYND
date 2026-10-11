"use client";

import { useCallback, useEffect, useRef } from "react";

import {
  SERVER_TIME_PATH,
  estimateServerClockOffset,
  serverClockNow,
} from "../lib/serverClock";

/**
 * A page's own estimate of the server's clock, for timing a read against a
 * server-stamped deadline — without it, a clocked game starts late (or pays a
 * wasted read) on every device whose clock disagrees with the server's.
 *
 * Returns a STABLE `serverNow()` that answers `null` until the first sample
 * lands. A null answer is meaningful and must not be papered over: with no
 * estimate, `Date.now()` is not the server's clock, and `useDeadlineRead` falls
 * back to its full skew-covering slack rather than anchoring on a guess.
 *
 * `estimateServerClockOffset` attributes half the round trip to each direction,
 * so a single sample leaves only the RTT's asymmetry — a few ms — behind. The
 * sample is taken once per mount: skew drifts slowly (NTP, a suspension) and the
 * read's own retry covers the tail, so re-sampling on a timer would buy nothing
 * and cost requests. A page that ALREADY has an estimate from its own match poll
 * should pass that instead — it is free and refreshed continuously.
 */
export function useServerClockEstimate(): () => number | null {
  // Offset (device − server), or null until a sample lands. A ref because the
  // returned accessor must keep one identity for the life of the page: it is
  // handed to a hook that arms a timer from it.
  const offsetRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const sample = async () => {
      try {
        const sentAtDeviceMs = Date.now();
        const res = await fetch(SERVER_TIME_PATH, { cache: "no-store" });
        const receivedAtDeviceMs = Date.now();
        const data = await res.json();
        const offsetMs = estimateServerClockOffset({
          sentAtDeviceMs,
          receivedAtDeviceMs,
          serverNowMs: Number(data?.now),
        });
        if (!cancelled && offsetMs !== null) offsetRef.current = offsetMs;
      } catch {
        // Best-effort: no sample means the caller keeps its conservative slack.
      }
    };
    void sample();
    return () => {
      cancelled = true;
    };
  }, []);

  return useCallback(() => {
    const offsetMs = offsetRef.current;
    if (offsetMs === null) return null;
    return serverClockNow(Date.now(), offsetMs);
  }, []);
}
