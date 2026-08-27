"use client";
import React, { useRef, useEffect, useCallback, useState, useImperativeHandle, forwardRef } from "react";
import { IconCircleCheck } from "@tabler/icons-react";
import CrashGraph, {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  DEFAULT_MAX_MULTIPLIER,
} from "./CrashGraph";
import CrashMultiplier from "./CrashMultiplier";
import Explosion from "./Explosion";
import CashoutButton from "./CashoutButton";
import useCrashAnimation from "./useCrashAnimation";

/**
 * CrashEngine — pure game engine for the Crash multiplier curve.
 *
 * Responsibilities:
 *   • Runs the exponential multiplier animation
 *   • Renders the canvas graph (CrashGraph)
 *   • Displays the current multiplier (CrashMultiplier)
 *   • Shows crash explosion overlay (Explosion) + frozen crash frame
 *   • Handles the cashout button click → calls onCashout(multiplier)
 *
 * Knows NOTHING about:
 *   • Wagers, wallets, balances, payouts, house edge
 *   • Bet amounts, bet placement, win/loss settlement
 *   • Auto-cashout thresholds (that's the parent's concern)
 *
 * Props:
 *   crashPoint      — multiplier at which the curve crashes (null = unknown:
 *                     Crash Poker hides it server-side; the curve flies
 *                     until triggerCrash() is called by the parent when the
 *                     server announces the crash)
 *   running         — when true, starts the animation
 *   startedAt       — server epoch-ms when the hand started; aligns the
 *                     curve so all clients render the same multiplier at
 *                     the same wall-clock moment
 *   curveFrom       — multiplier the current flight segment starts from
 *                     (1.00 at hand start, or the checkpoint multiplier
 *                     after a betting window closes) — pause-aware curve
 *   curveResumedAt  — server epoch-ms the current flight segment started
 *                     (hand start, or the moment the last checkpoint
 *                     closed); the curve pauses at betting checkpoints
 *                     and resumes from them (pause-aware curve)
 *   curveCap        — multiplier to HOLD at while a betting checkpoint
 *                     window is open (null = free climb) — the flight
 *                     stops at every 0.25x increment for decisions
 *   onCashout       — (multiplier: number) => void — called when user cashes out
 *   onCrash         — (multiplier: number) => void — called when game crashes
 *   onMultiplierUpdate — (multiplier: number, isCrashed: boolean) => void — live feed
 *
 * Ref API:
 *   cashout()      — trigger a manual cashout at the current multiplier
 *   triggerCrash(multiplier) — crash the hand at a server-announced
 *                     multiplier (Crash Poker: the client never knows the
 *                     crash point in advance)
 */
const CrashEngine = forwardRef(function CrashEngine({
  crashPoint = null,
  running = false,
  startedAt = null,
  curveFrom = 1,
  curveResumedAt = null,
  curveCap = null,
  onCashout,
  onCrash,
  onMultiplierUpdate,
}, ref) {
  const crashGraphRef = useRef(null);
  const frozenRafRef = useRef(null);
  const [displayMultiplier, setDisplayMultiplier] = useState(1.0);
  const [isCrashed, setIsCrashed] = useState(false);
  const [hasCashout, setHasCashout] = useState(false);
  const [cashoutMultiplier, setCashoutMultiplier] = useState(null);

  // Y-axis upper bound: unknown crash point → fixed generous scale (any
  // point in the game's range fits); known → always show 20% past it.
  const maxMultiplier = crashPoint
    ? Math.max(crashPoint * 1.2, 2)
    : DEFAULT_MAX_MULTIPLIER;

  // Animation hook
  const {
    getCurrentMultiplier,
    triggerCrash,
  } = useCrashAnimation({
    crashPoint,
    running,
    startedAt,
    curveFrom,
    curveResumedAt,
    curveCap,
    onFrame: useCallback(({ multiplier, currentMultiplier, points, crashed }) => {
      setDisplayMultiplier(multiplier);
      setIsCrashed(crashed);
      if (onMultiplierUpdate) onMultiplierUpdate(multiplier, crashed);

      // Draw the curve from the frame payload — self-contained so we never
      // reference stateRef before it's destructured from the hook (TDZ guard).
      if (crashGraphRef.current) {
        crashGraphRef.current.draw({
          curvePoints: points,
          currentMultiplier,
          crashed,
          crashCanvasPoint: null,
          crashAt: null,
          explosionProgress: 0,
        }, performance.now());
      }
    }, [onMultiplierUpdate]),
    onCrash: useCallback((lossMultiplier, crashCanvasPoint, animState) => {
      setIsCrashed(true);
      setDisplayMultiplier(lossMultiplier);
      if (onMultiplierUpdate) onMultiplierUpdate(lossMultiplier, true);

      const drawFrozen = (now) => {
        if (crashGraphRef.current) {
          crashGraphRef.current.draw(animState, now);
        }
        if (animState.explosionProgress < 1) {
          frozenRafRef.current = requestAnimationFrame(drawFrozen);
        }
      };
      frozenRafRef.current = requestAnimationFrame(drawFrozen);

      if (onCrash) onCrash(lossMultiplier);
    }, [onCrash, onMultiplierUpdate]),
  });

  // Cleanup frozen frame rAF
  useEffect(() => {
    return () => {
      if (frozenRafRef.current) cancelAnimationFrame(frozenRafRef.current);
    };
  }, []);

  // Reset state when a new round starts
  useEffect(() => {
    if (running) {
      setHasCashout(false);
      setCashoutMultiplier(null);
      setIsCrashed(false);
      setDisplayMultiplier(1.0);
    }
  }, [running]);

  // Initial draw
  useEffect(() => {
    if (crashGraphRef.current) {
      crashGraphRef.current.reset();
    }
  }, []);

  // Handle manual cashout.
  // IMPORTANT: cashing out must NOT stop the animation — the rocket keeps
  // flying for everyone until the server-authoritative crash point is hit.
  // The player is simply marked safe at their multiplier while the curve
  // (and their balance outcome) still resolves at the real crash.
  const handleCashout = useCallback(() => {
    if (!running || isCrashed || hasCashout) return;
    const mult = parseFloat(getCurrentMultiplier().toFixed(2));
    setHasCashout(true);
    setCashoutMultiplier(mult);
    if (onCashout) onCashout(mult);
  }, [running, isCrashed, hasCashout, getCurrentMultiplier, onCashout]);

  // Expose cashout() + triggerCrash() via ref
  useImperativeHandle(ref, () => ({
    cashout() {
      handleCashout();
    },
    /** Crash the hand at a server-announced multiplier (Crash Poker). */
    triggerCrash(multiplier) {
      triggerCrash(multiplier, maxMultiplier);
    },
  }), [handleCashout, triggerCrash, maxMultiplier]);

  // Y-axis labels
  const yAxisLabels = (() => {
    const steps = 6;
    return Array.from({ length: steps + 1 }, (_, i) => {
      const value = 1 + ((maxMultiplier - 1) * (steps - i)) / steps;
      return (
        <div key={i} className="text-sm text-gray-400">
          {value.toFixed(2)}x
        </div>
      );
    });
  })();

  return (
    <>
      {/* Fill the parent 4:3 game container — the internal drawing uses the
          fixed 800×600 coordinate space and the container matches that
          aspect ratio, so CSS scaling stays perfectly uniform. */}
      <CrashGraph
        ref={crashGraphRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        maxMultiplier={maxMultiplier}
        className="absolute inset-0 z-0"
      />

      <div className="absolute right-2 top-0 bottom-0 flex flex-col justify-between z-10 py-6">
        {yAxisLabels}
      </div>

      <Explosion isCrashed={isCrashed} />

      {/* Cashed-out badge — shown while the rocket is still flying */}
      {hasCashout && !isCrashed && (
        <div className="absolute top-6 left-1/2 -translate-x-1/2 z-20 px-4 py-1.5 rounded-full bg-[#00ffa6]/20 border border-[#00ffa6]/50 text-[#00ffa6] font-bold text-sm backdrop-blur-sm">
          <IconCircleCheck size={16} className="mr-1.5" /> Cashed out at {cashoutMultiplier?.toFixed(2)}x
        </div>
      )}

      <CrashMultiplier multiplier={displayMultiplier} isCrashed={isCrashed} />
    </>
  );
});

export default CrashEngine;

// Also export CashoutButton for convenience
export { CashoutButton };
