"use client";

// ── Per-round result reveal for the Precision match page ─────────────────
//
// Fires on each fresh DECISION, never on a phase change.
//
// The server stamps `state.lastRoundStops` (+ the `lastRoundTargetMs` it was
// graded against) exactly when a round is decided — a winner or a tie. Each
// time those values form a new shape we snapshot them into `reveal` so the
// dedicated overlay can show them for `ROUND_RESULT_REVEAL_MS`. The identity
// used to detect "a new decision" is derived ONLY from the decided round's
// server-stamped telemetry (never from `targetMs`, which flips `null → T` when
// the NEXT round opens): that is what keeps the reveal tied to "a round just
// ended" instead of "the phase changed" — the previous version re-fired on the
// next round's target and re-showed the finished round on top of the live one.
//
// The same decision landing via both the socket broadcast AND the polling tick
// produces an identical signature, so it shows once.

import { useCallback, useEffect, useRef, useState } from "react";

import { ROUND_RESULT_REVEAL_MS } from "../components/precision/PrecisionRoundResultPanel";
import { buildRoundResultReveal, type RoundResultReveal } from "../lib/precision/matchView";
import { playRankSound } from "../lib/precisionAudio";
import type { PlayerSeat, PrecisionState } from "../lib/precision/types";

export interface UsePrecisionRoundRevealOptions {
  state: PrecisionState | null;
  localSeat: PlayerSeat;
}

export interface UsePrecisionRoundRevealResult {
  /** The decision currently being revealed, or null when nothing is showing. */
  reveal: RoundResultReveal | null;
  /** Dismiss early (the overlay's own affordance). */
  dismissReveal: () => void;
}

export function usePrecisionRoundReveal({
  state,
  localSeat,
}: UsePrecisionRoundRevealOptions): UsePrecisionRoundRevealResult {
  const [reveal, setReveal] = useState<RoundResultReveal | null>(null);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Identity of the last DECISION we revealed.
  const lastDecisionKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const next = buildRoundResultReveal(state);
    if (!next) return;
    if (lastDecisionKeyRef.current === next.signature) return;

    lastDecisionKeyRef.current = next.signature;
    setReveal(next);
    // Start the reveal window for THIS decision. Clearing the prior handle
    // prevents an early dismiss when rounds land back-to-back.
    if (revealTimerRef.current !== null) clearTimeout(revealTimerRef.current);
    revealTimerRef.current = setTimeout(() => {
      setReveal(null);
      revealTimerRef.current = null;
    }, ROUND_RESULT_REVEAL_MS);
  }, [
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

  return { reveal, dismissReveal };
}
