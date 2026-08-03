"use client";
import { useRef, useCallback, useEffect } from "react";
import { toCanvasPoint } from "./CrashGraph";
import { CANVAS_WIDTH, CANVAS_HEIGHT, GRAPH_PADDING, GROWTH_RATE } from "./CrashGraph";

const UI_MULTIPLIER_UPDATE_MS = 80;
const MAX_CURVE_POINTS = 450;

/**
 * useCrashAnimation — runs the exponential multiplier growth loop.
 *
 * Pure animation engine. Knows nothing about money, bets, or payouts.
 * Detects when the multiplier reaches the crash point and calls onCrash.
 *
 * Params:
 *   crashPoint  — multiplier at which the game crashes
 *   running     — when true, starts the animation; when false, stops it
 *   onFrame     — called every ~80ms with { multiplier, points, crashed }
 *   onCrash     — called when multiplier >= crashPoint
 */
export default function useCrashAnimation({
  crashPoint,
  running = false,
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

    const maxMultiplier = Math.max(crashPointRef.current * 1.2, 2);
    const startTime = performance.now();

    stateRef.current = {
      startTime,
      currentMultiplier: 1,
      displayMultiplier: 1,
      crashPoint: crashPointRef.current,
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
      const didCrash = roundedMultiplier >= s.crashPoint;

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

      // Crash check — only thing the engine detects autonomously
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
  };
}
