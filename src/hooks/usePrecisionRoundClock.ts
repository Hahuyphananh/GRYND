"use client";

// ── The Precision round clock ────────────────────────────────────────────
//
// Owns every time-shaped value the match page displays:
//
//   * `timerMs`              — the live elapsed counter for the round in flight,
//   * `countdownMs`          — the pre-round countdown while the server arms,
//   * `selfFrozenElapsedMs`  — where the local player's rocket parked on STOP.
//
// All three are VISUAL. The number that decides a round is the server's
// (`recordRoundStop` measures `Date.now() - roundGoInstant`), so the display
// clock is anchored to that same server GO instant via `roundClock.ts` — the
// poll round trip and the device's clock skew both cancel out of the pairing,
// which is what makes the number on screen the number the server will measure.
// The loop FREEZES the instant the player hits STOP (`freezeTimer`), so the
// timer and the local rocket park on the spot instead of running on until the
// round resolves.
//
// This hook also owns the ARMED→ACTIVE fast re-poll: the server flips the
// phase at the stamped `countdownEndsAt`, and without it the client would
// otherwise sit on 0 until the next scheduled poll.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  ARMING_FAST_POLL_INTERVAL_MS,
  ARMING_FAST_POLL_MAX_ATTEMPTS,
} from "../lib/precision/constants";
import {
  elapsedSince,
  pairScheduledGo,
  resolveRoundAnchorLocal,
  type ScheduledGoPairing,
} from "../lib/precision/roundClock";
import type { PrecisionState } from "../lib/precision/types";

export interface UsePrecisionRoundClockOptions {
  state: PrecisionState | null;
  /** The canonical match refresh (from `usePrecisionMatchState`). */
  refreshState: () => Promise<void>;
}

export interface UsePrecisionRoundClockResult {
  /** Live display clock (ms) for the round in flight. */
  timerMs: number;
  /** Pre-round countdown remaining (ms), or null while not arming. */
  countdownMs: number | null;
  /** Elapsed ms the local player is frozen at after STOP, or null while flying. */
  selfFrozenElapsedMs: number | null;
  /** Park the display clock AND the local rocket on the spot; called the
   *  instant STOP is sent. Returns the frozen elapsed value. */
  freezeTimer: () => number;
  /** Release the freeze so the next `active` round starts flying from zero. */
  releaseFreeze: () => void;
}

export function usePrecisionRoundClock({
  state,
  refreshState,
}: UsePrecisionRoundClockOptions): UsePrecisionRoundClockResult {
  const [timerMs, setTimerMs] = useState(0);
  const [selfFrozenElapsedMs, setSelfFrozenElapsedMs] = useState<number | null>(null);
  const [countdownMs, setCountdownMs] = useState<number | null>(null);

  const timerRafRef = useRef<number | null>(null);
  // Local monotonic instant the round's display clock is anchored to — the
  // SERVER's GO instant expressed in `performance.now()` terms.
  const anchorLocalRef = useRef<number | null>(null);
  // The scheduled GO of the current round, paired to the local clock while the
  // round arms (available BEFORE the round opens, so the anchor is exact).
  const scheduledGoRef = useRef<ScheduledGoPairing | null>(null);

  const stopTimer = useCallback(() => {
    if (timerRafRef.current !== null) {
      cancelAnimationFrame(timerRafRef.current);
      timerRafRef.current = null;
    }
  }, []);

  const freezeTimer = useCallback((): number => {
    stopTimer();
    const anchor = anchorLocalRef.current;
    const frozen = anchor === null ? 0 : elapsedSince(anchor, performance.now());
    setTimerMs(frozen);
    // Also park the local rocket: `selfFrozenElapsedMs` is what tells the
    // board this lane has stopped.
    setSelfFrozenElapsedMs(frozen);
    return frozen;
  }, [stopTimer]);

  const startTimer = useCallback(
    (anchorLocalMs: number) => {
      stopTimer();
      anchorLocalRef.current = anchorLocalMs;
      // Paint the server-derived elapsed immediately so the display never
      // flashes a stale 0 before the first rAF frame.
      setTimerMs(elapsedSince(anchorLocalMs, performance.now()));
      const tick = () => {
        if (anchorLocalRef.current === null) return;
        setTimerMs(elapsedSince(anchorLocalRef.current, performance.now()));
        timerRafRef.current = requestAnimationFrame(tick);
      };
      timerRafRef.current = requestAnimationFrame(tick);
    },
    [stopTimer]
  );

  const releaseFreeze = useCallback(() => setSelfFrozenElapsedMs(null), []);

  // ── Pair the scheduled GO while the round arms ─────────────────────
  // `countdownEndsAt` is the server's SCHEDULED "round opens" instant. Read
  // alongside `Date.now()` from the same response it becomes that instant in
  // the local monotonic clock (the round trip and any device clock skew drop
  // out of the difference), which is what removes the poll lag from the
  // displayed timer. See `roundClock.ts`.
  useEffect(() => {
    if (state?.phase !== "arming") return;
    const endsAt = state?.countdownEndsAt;
    if (typeof endsAt !== "number") return;
    scheduledGoRef.current = pairScheduledGo({
      countdownEndsAt: endsAt,
      roundSequence: state?.roundSequence ?? 0,
      localNowMs: performance.now(),
      deviceNowMs: Date.now(),
    });
  }, [state?.phase, state?.countdownEndsAt, state?.roundSequence]);

  // ── Start / stop the local running timer based on phase ────────
  // When the round flips to `active`, the display clock starts from the
  // SERVER's GO instant (paired scheduled GO + the reveal's server-side
  // drift), so the number the player times against is the number the server
  // measures. When the round resolves (any phase other than `active`) the
  // loop stops and the display resets.
  //
  // NOTE: the effect deliberately does NOT depend on the STOP-pending flag —
  // the STOP handler freezes the clock itself (`freezeTimer`) and a dependency
  // on that flag would re-run this effect on the click and restart the very
  // loop we just stopped.
  useEffect(() => {
    if (state?.phase === "active") {
      const anchor = resolveRoundAnchorLocal({
        scheduled: scheduledGoRef.current,
        goInstant: state?.roundGoInstant ?? null,
        roundSequence: state?.roundSequence ?? null,
        localNowMs: performance.now(),
        deviceNowMs: Date.now(),
      });
      startTimer(anchor);
    } else {
      stopTimer();
      setTimerMs(0);
    }
    return () => stopTimer();
  }, [state?.phase, state?.roundGoInstant, state?.roundSequence, startTimer, stopTimer]);

  // ── Pre-round countdown ticker ─────────────────────────────────
  // During `arming`, the server stamps `countdownEndsAt`
  // (`armingStartedAt + ROUND_COUNTDOWN_MS`). We tick every 100ms and
  // display ceil(remaining/1000) so both clients show the same
  // 5…4…3…2…1 from the same server timestamp. The server's own transition
  // fires at that exact instant and flips the phase to "active", so the
  // countdown is display-only — all round timing remains server-authoritative.
  useEffect(() => {
    const endsAt = state?.countdownEndsAt;
    if (state?.phase !== "arming" || typeof endsAt !== "number") {
      setCountdownMs(null);
      return;
    }
    const tick = () => setCountdownMs(Math.max(0, endsAt - Date.now()));
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [state?.phase, state?.countdownEndsAt]);

  // ── Fast re-poll the instant the countdown expires ─────────────
  // The server flips `arming` → `active` at the server-stamped
  // `countdownEndsAt`, but the client otherwise only learns about it on the
  // next `MATCH_POLL_INTERVAL_MS` tick (the `roundArmStart` broadcast fires
  // when the next round is ARMED, not when it opens). That left the
  // countdown sitting on 0 before every round — the "timer stuck on 0"
  // report — and opened the round (plus its target) late. Once the stamped
  // countdown has elapsed we re-poll at `ARMING_FAST_POLL_INTERVAL_MS` until
  // the phase flips; the burst is budgeted by
  // `ARMING_FAST_POLL_MAX_ATTEMPTS`, after which the normal cadence takes over.
  //
  // This read is also what self-heals the transition server-side:
  // `get-match` promotes a due armed round, so the round opens on the first
  // request after the countdown ends even if the server's arming timer never
  // fired (frozen instance, process restart).
  useEffect(() => {
    if (state?.phase !== "arming") return;
    const endsAt = state?.countdownEndsAt;
    if (typeof endsAt !== "number") return;
    let attempts = 0;
    const pollIfDue = () => {
      if (Date.now() < endsAt) return;
      attempts += 1;
      void refreshState();
      if (attempts >= ARMING_FAST_POLL_MAX_ATTEMPTS) clearInterval(id);
    };
    const id = setInterval(pollIfDue, ARMING_FAST_POLL_INTERVAL_MS);
    pollIfDue();
    return () => clearInterval(id);
  }, [state?.phase, state?.countdownEndsAt, refreshState]);

  // Stop the rAF loop on unmount so a torn-down React tree never keeps
  // ticking a frame callback.
  useEffect(() => stopTimer, [stopTimer]);

  return {
    timerMs,
    countdownMs,
    selfFrozenElapsedMs,
    freezeTimer,
    releaseFreeze,
  };
}
