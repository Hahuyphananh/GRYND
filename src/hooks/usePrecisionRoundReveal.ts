"use client";

// ── Per-round result reveal for the Precision match page ─────────────────
//
// Fires on each fresh DECISION, never on a phase change.
//
// The server stamps `state.lastRoundStops` (+ the `lastRoundTargetMs` it was
// graded against) exactly when a round is decided — a winner or a tie. Each
// time those values form a new shape we snapshot them into `reveal` so the
// dedicated overlay can show them for the rest of `ROUND_RESULT_REVEAL_MS`.
// The identity used to detect "a new decision" is derived ONLY from the decided
// round's server-stamped telemetry (never from `targetMs`, which flips
// `null → T` when the NEXT round opens): that is what keeps the reveal tied to
// "a round just ended" instead of "the phase changed" — the previous version
// re-fired on the next round's target and re-showed the finished round on top
// of the live one.
//
// The same decision landing via both the socket broadcast AND the polling tick
// produces an identical signature, so it shows once.
//
// ── When the reveal ends: the SEQUENCING rule ────────────────────────────
//
// Two things decide how long the popup stays, and both are server-anchored:
//
//   1. `revealWindowMsOf` measures the window from the DECISION the server
//      stamped (`armingStartedAt`), not from the moment this client happened to
//      observe it. The popup therefore ends exactly when the server's
//      countdown begins, which is what leaves the player a whole
//      `ROUND_COUNTDOWN_MS` of pre-round countdown AFTER the result — instead
//      of the countdown's tail, which is all a window measured from observation
//      could leave when the result arrived late.
//   2. The reveal is dropped outright the instant the next round is LIVE.
//      That is a hard guarantee, not a side effect of the timer: whatever
//      the client's lag, the previous round's result can never sit on top of
//      the round the player is now flying. A reveal is likewise never STARTED
//      while a round is live — a client that mounts (or reconciles) mid-round
//      still carries the previous round's `lastRoundStops`, and showing it
//      there is the same overlap from the other direction.

import { useCallback, useEffect, useRef, useState } from "react";

import { ROUND_RESULT_REVEAL_MS } from "../lib/precision/constants";
import {
  buildRoundResultReveal,
  revealWindowMsOf,
  type RoundResultReveal,
} from "../lib/precision/matchView";
import { playRankSound } from "../lib/precisionAudio";
import { serverClockNow } from "../lib/precision/roundClock";
import type { PlayerSeat, PrecisionState } from "../lib/precision/types";

export interface UsePrecisionRoundRevealOptions {
  state: PrecisionState | null;
  localSeat: PlayerSeat;
  /** Device→server wall-clock offset, from `usePrecisionMatchState`. The
   *  reveal window is anchored on the server's decision stamp, so measuring it
   *  needs "now" on the server's clock — a device whose wall clock is off would
   *  otherwise hold the popup over the countdown (or cut it to a flash). */
  serverClockOffsetMs?: number;
}

export interface UsePrecisionRoundRevealResult {
  /** The decision currently being revealed, or null when nothing is showing. */
  reveal: RoundResultReveal | null;
  /** How long THIS reveal has on screen (ms), from the window this hook
   *  measured for it. The overlay renders it as the "next round in Ns"
   *  countdown, so the player sees the real remainder instead of a fixed 3s. */
  revealWindowMs: number;
  /** Dismiss early (the overlay's own affordance). */
  dismissReveal: () => void;
}

export function usePrecisionRoundReveal({
  state,
  localSeat,
  serverClockOffsetMs = 0,
}: UsePrecisionRoundRevealOptions): UsePrecisionRoundRevealResult {
  const [reveal, setReveal] = useState<RoundResultReveal | null>(null);
  const [revealWindowMs, setRevealWindowMs] = useState(ROUND_RESULT_REVEAL_MS);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Identity of the last DECISION we revealed.
  const lastDecisionKeyRef = useRef<string | null>(null);
  // Read through a ref so refining the offset does not re-run the decision
  // effect and (via its signature guard) leave a live reveal's timer alone.
  const offsetRef = useRef(serverClockOffsetMs);
  offsetRef.current = serverClockOffsetMs;

  useEffect(() => {
    // A reveal belongs to a round that has ENDED. A decision always lands on
    // `arming` (the next round held behind the result) or `finished` (match
    // over) — never on `active`, which is a round IN FLIGHT. Without this gate,
    // a client that mounts or reconciles mid-round picks the previous round's
    // decision out of the snapshot and paints it over the live round.
    if (state?.phase === "active") return;
    const next = buildRoundResultReveal(state);
    if (!next) return;
    if (lastDecisionKeyRef.current === next.signature) return;

    lastDecisionKeyRef.current = next.signature;
    setReveal(next);
    const windowMs = revealWindowMsOf(state, serverClockNow(Date.now(), offsetRef.current));
    setRevealWindowMs(windowMs);
    // Start the reveal window for THIS decision. Clearing the prior handle
    // prevents an early dismiss when rounds land back-to-back. The window is
    // measured from the server's decision stamp, so it ends where the server's
    // own cooldown does — see `revealWindowMsOf`.
    if (revealTimerRef.current !== null) clearTimeout(revealTimerRef.current);
    revealTimerRef.current = setTimeout(
      () => {
        setReveal(null);
        revealTimerRef.current = null;
      },
      windowMs
    );
  }, [
    state?.phase,
    state?.lastRoundStops?.seat1?.stopInstant,
    state?.lastRoundStops?.seat1?.elapsedMs,
    state?.lastRoundStops?.seat1?.diffMs,
    state?.lastRoundStops?.seat2?.stopInstant,
    state?.lastRoundStops?.seat2?.elapsedMs,
    state?.lastRoundStops?.seat2?.diffMs,
    state?.lastRoundWinnerSeat,
    state?.lastRoundTargetMs,
    state?.targetMs,
  ]);

  // Play the rank-appropriate sound for the local player's diff whenever the
  // reveal panel appears.
  useEffect(() => {
    if (!reveal) return;
    const localDiff = localSeat === 1 ? reveal.seat1DiffMs : reveal.seat2DiffMs;
    playRankSound(localDiff);
  }, [reveal, localSeat]);

  const dismissReveal = useCallback(() => {
    setReveal(null);
    if (revealTimerRef.current !== null) {
      clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
  }, []);

  // ── The next round is LIVE → the result popup is gone ─────────────────
  // The hard half of the sequencing rule. The window above already ends when
  // the server's countdown begins, but a client whose decision arrived late
  // (or whose clock estimate is off) must never be shown the previous round's
  // result while it is flying the new one — the round opening drops it here,
  // whatever the timer thinks.
  useEffect(() => {
    if (state?.phase === "active") dismissReveal();
  }, [state?.phase, dismissReveal]);

  // Cancel the auto-dismiss timer on unmount so a stale timer can't call
  // setState on a torn-down React tree.
  useEffect(() => {
    return () => {
      if (revealTimerRef.current !== null) {
        clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
    };
  }, []);

  return { reveal, revealWindowMs, dismissReveal };
}
