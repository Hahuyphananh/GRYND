"use client";
import { useRef, useCallback, useEffect } from "react";
import { toCanvasPoint } from "./CrashGraph";
import {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  GRAPH_PADDING,
  GROWTH_RATE,
  DEFAULT_MAX_MULTIPLIER,
} from "./CrashGraph";

const UI_MULTIPLIER_UPDATE_MS = 80;
const MAX_CURVE_POINTS = 450;

/**
 * useCrashAnimation — runs the exponential multiplier growth loop.
 *
 * Pure animation engine. Knows nothing about money, bets, or payouts.
 *
 * Two crash modes:
 *   • crashPoint provided (legacy / solo crash): the engine detects when
 *     the multiplier reaches the crash point and calls onCrash itself.
 *   • crashPoint null (Crash Poker): the crash point is server-only and
 *     NEVER sent to clients before the crash — the curve flies "blind"
 *     and the crash is triggered from outside via `triggerCrash()` when
 *     the server announces it. The engine is NOT the source of truth for
 *     when the crash happens.
 *
 * Params:
 *   crashPoint  — multiplier at which the game crashes (null = unknown /
 *                 server-triggered crash only)
 *   running     — when true, starts the animation; when false, stops it
 *   startedAt   — server epoch-ms when the hand started; the curve is
 *                 aligned to it so every client renders the same
 *                 multiplier at the same wall-clock moment
 *   onFrame     — called every ~80ms with { multiplier, points, crashed }
 *   onCrash     — called when the crash happens (autonomous or triggered)
 */
export default function useCrashAnimation({
  crashPoint,
  running = false,
  startedAt = null,
  onFrame,
  onCrash,
}) {
  const rafRef = useRef(null);

  const stateRef = useRef({
    startTime: 0,
    currentMultiplier: 1,
    displayMultiplier: 1,
    crashPoint: 0,
    curvePoints: [],
    crashed: false,
    crashAt: null,
    crashCanvasPoint: null,
    explosionProgress: 0,
    lastUiUpdateAt: 0,
  });

  // Keep crashPoint synced without restarting
  const crashPointRef = useRef(crashPoint);
  useEffect(() => {
    crashPointRef.current = crashPoint;
  }, [crashPoint]);

  const startedAtRef = useRef(startedAt);
  useEffect(() => {
    startedAtRef.current = startedAt;
  }, [startedAt]);

  // Persist callbacks in refs so the animation loop always calls the latest
  const callbacksRef = useRef({ onFrame, onCrash });
  useEffect(() => {
    callbacksRef.current = { onFrame, onCrash };
  });

  const stop = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    stop();

    // Unknown crash point → fixed y-scale; known → scale to the point.
    const cp = crashPointRef.current;
    const maxMultiplier = cp ? Math.max(cp * 1.2, 2) : DEFAULT_MAX_MULTIPLIER;

    // Align the curve to the server's hand start (epoch ms): the animation
    // begins `elapsed` ms into the curve instead of at t=0, so a client
    // that received the broadcast late still renders the same multiplier
    // everyone else sees at that moment. Never starts in the future.
    const startedAtMs = Number(startedAtRef.current) || 0;
    const startTime = startedAtMs
      ? performance.now() - Math.max(0, Date.now() - startedAtMs)
      : performance.now();

    stateRef.current = {
      startTime,
      currentMultiplier: 1,
      displayMultiplier: 1,
      crashPoint: cp || 0,
      curvePoints: [{ x: GRAPH_PADDING, y: CANVAS_HEIGHT - GRAPH_PADDING }],
      crashed: false,
      crashAt: null,
      crashCanvasPoint: null,
      explosionProgress: 0,
      lastUiUpdateAt: 0,
    };

    const animationLoop = (now) => {
      const s = stateRef.current;
      const elapsedSeconds = (now - s.startTime) / 1000;
      const deterministicMultiplier = Math.exp(GROWTH_RATE * elapsedSeconds);
      const roundedMultiplier = parseFloat(deterministicMultiplier.toFixed(4));
      // Autonomous crash detection only when the engine knows the point.
      // With an unknown point (Crash Poker) the curve flies until the
      // server announces the crash — the engine never decides it.
      const hasKnownCrashPoint = s.crashPoint > 0;
      const didCrash = hasKnownCrashPoint && roundedMultiplier >= s.crashPoint;

      s.currentMultiplier = didCrash ? s.crashPoint : roundedMultiplier;
      s.displayMultiplier = parseFloat(s.currentMultiplier.toFixed(2));
      const currentPoint = toCanvasPoint(
        s.currentMultiplier,
        maxMultiplier,
        CANVAS_WIDTH,
        CANVAS_HEIGHT,
        GRAPH_PADDING,
      );
      s.curvePoints.push(currentPoint);
      if (s.curvePoints.length > MAX_CURVE_POINTS) {
        s.curvePoints.shift();
      }

      // Throttled UI updates
      if (now - s.lastUiUpdateAt > UI_MULTIPLIER_UPDATE_MS) {
        s.lastUiUpdateAt = now;
        const cb = callbacksRef.current;
        if (cb.onFrame) {
          cb.onFrame({
            multiplier: s.displayMultiplier,
            currentMultiplier: s.currentMultiplier,
            points: s.curvePoints,
            crashed: s.crashed,
          });
        }
      }

      // Autonomous crash check — only when the engine knows the point
      if (didCrash) {
        const lossMultiplier = parseFloat(s.currentMultiplier.toFixed(2));
        const crashCanvasPoint = toCanvasPoint(
          lossMultiplier,
          maxMultiplier,
          CANVAS_WIDTH,
          CANVAS_HEIGHT,
          GRAPH_PADDING,
        );
        s.crashed = true;
        s.crashAt = performance.now();
        s.crashCanvasPoint = crashCanvasPoint;
        s.explosionProgress = 0;

        cancelAnimationFrame(rafRef.current);
        const cb = callbacksRef.current;
        if (cb.onCrash) {
          cb.onCrash(lossMultiplier, crashCanvasPoint, s);
        }
        return;
      }

      rafRef.current = requestAnimationFrame(animationLoop);
    };

    rafRef.current = requestAnimationFrame(animationLoop);
  }, [stop]);

  // Start/stop based on `running` prop
  useEffect(() => {
    if (running) {
      start();
    } else {
      stop();
    }
    return stop;
  }, [running, start, stop]);

  return {
    stateRef,
    stop,
    /** Manually trigger cashout at the current multiplier */
    getCurrentMultiplier: useCallback(() => {
      return stateRef.current.currentMultiplier;
    }, []),
    /** Mark as crashed from outside (e.g. when user cashes out) */
    markCrashed: useCallback((cashoutMultiplier, maxMultiplier = 2) => {
      const s = stateRef.current;
      s.crashed = true;
      const crashCanvasPoint = toCanvasPoint(
        cashoutMultiplier,
        maxMultiplier,
        CANVAS_WIDTH,
        CANVAS_HEIGHT,
        GRAPH_PADDING,
      );
      s.crashCanvasPoint = crashCanvasPoint;
      s.crashAt = performance.now();
      s.explosionProgress = 0;
      stop();
    }, [stop]),
    /**
     * Crash the hand from OUTSIDE the engine — used by Crash Poker, where
     * the crash point is server-only. `multiplier` is the server-revealed
     * crash point (announced at the moment of the crash, never before).
     * Freezes the curve, draws the explosion at that multiplier's canvas
     * point and fires onCrash (which CrashEngine uses to run the frozen
     * explosion frame loop).
     */
    triggerCrash: useCallback((multiplier, maxMultiplier) => {
      const s = stateRef.current;
      const crashMult = parseFloat(Number(multiplier).toFixed(2));
      if (!Number.isFinite(crashMult) || crashMult < 1) return;
      const mMax =
        maxMultiplier ||
        (crashPointRef.current
          ? Math.max(crashPointRef.current * 1.2, 2)
          : DEFAULT_MAX_MULTIPLIER);
      const crashCanvasPoint = toCanvasPoint(
        crashMult,
        mMax,
        CANVAS_WIDTH,
        CANVAS_HEIGHT,
        GRAPH_PADDING,
      );
      s.crashed = true;
      s.currentMultiplier = crashMult;
      s.displayMultiplier = crashMult;
      s.crashAt = performance.now();
      s.crashCanvasPoint = crashCanvasPoint;
      s.explosionProgress = 0;
      stop();
      const cb = callbacksRef.current;
      if (cb.onCrash) {
        cb.onCrash(crashMult, crashCanvasPoint, s);
      }
    }, [stop]),
  };
}
