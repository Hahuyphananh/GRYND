"use client";
import React, { useRef, useEffect, useCallback, useState, useImperativeHandle, forwardRef } from "react";
import CrashGraph, { CANVAS_WIDTH, CANVAS_HEIGHT } from "./CrashGraph";
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
 *   crashPoint      — multiplier at which the curve crashes
 *   running         — when true, starts the animation
 *   onCashout       — (multiplier: number) => void — called when user cashes out
 *   onCrash         — (multiplier: number) => void — called when game crashes
 *   onMultiplierUpdate — (multiplier: number, isCrashed: boolean) => void — live feed
 *
 * Ref API:
 *   cashout() — trigger a manual cashout at the current multiplier
 */
const CrashEngine = forwardRef(function CrashEngine({
  crashPoint = 2.0,
  running = false,
  onCashout,
  onCrash,
  onMultiplierUpdate,
}, ref) {
  const crashGraphRef = useRef(null);
  const frozenRafRef = useRef(null);
  const [displayMultiplier, setDisplayMultiplier] = useState(1.0);
  const [isCrashed, setIsCrashed] = useState(false);
  const [hasCashout, setHasCashout] = useState(false);

  // Y-axis upper bound: always show at least 20% past crash point
  const maxMultiplier = Math.max(crashPoint * 1.2, 2);

  // Animation hook
  const {
    stateRef,
    stop,
    getCurrentMultiplier,
    markCrashed,
  } = useCrashAnimation({
    crashPoint,
    running,
    onFrame: useCallback(({ multiplier, crashed }) => {
      setDisplayMultiplier(multiplier);
      setIsCrashed(crashed);
      if (onMultiplierUpdate) onMultiplierUpdate(multiplier, crashed);

      if (crashGraphRef.current) {
        crashGraphRef.current.draw(stateRef.current, performance.now());
      }
    }, [onMultiplierUpdate, stateRef]),
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

  // Expose cashout() via ref
  useImperativeHandle(ref, () => ({
    cashout() {
      handleCashout();
    },
  }), [handleCashout]);

  // Handle manual cashout
  const handleCashout = useCallback(() => {
    if (!running || isCrashed || hasCashout) return;
    const mult = parseFloat(getCurrentMultiplier().toFixed(2));
    setHasCashout(true);
    setIsCrashed(true);
    setDisplayMultiplier(mult);
    markCrashed(mult, maxMultiplier);
    stop();

    if (crashGraphRef.current) {
      crashGraphRef.current.draw(stateRef.current, performance.now());
    }

    if (onCashout) onCashout(mult);
    if (onMultiplierUpdate) onMultiplierUpdate(mult, true);
  }, [running, isCrashed, hasCashout, getCurrentMultiplier, markCrashed, maxMultiplier, stop, onCashout, onMultiplierUpdate, stateRef]);

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
      <CrashGraph
        ref={crashGraphRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        maxMultiplier={maxMultiplier}
        className="absolute bottom-0 left-0 z-0"
      />

      <div className="absolute right-2 top-0 bottom-0 flex flex-col justify-between z-10 py-6">
        {yAxisLabels}
      </div>

      <Explosion isCrashed={isCrashed} />

      <CrashMultiplier multiplier={displayMultiplier} isCrashed={isCrashed} />
    </>
  );
});

export default CrashEngine;

// Also export CashoutButton for convenience
export { CashoutButton };
