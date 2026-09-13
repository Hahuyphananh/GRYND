"use client";
import { useRef, useCallback, useEffect } from "react";
import { toCanvasPoint } from "./CrashGraph";
import {
  crashMultiplierAtTime,
  timeToCrashMultiplier,
} from "../../../lib/games/crash/constants";
import {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  GRAPH_PADDING,
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
 * Pause-aware curve (Crash Poker): the flight STOPS at every 0.25x betting
 * checkpoint. While a checkpoint window is open the curve holds at the
 * checkpoint multiplier (curveCap); when the window closes the server
 * advances flightResumedAt and the curve resumes climbing from that
 * multiplier. This keeps every client rendering the same multiplier at
 * the same wall-clock moment as the server.
 *
 * Params:
 *   crashPoint  — multiplier at which the game crashes (null = unknown /
 *                 server-triggered crash only)
 *   running     — when true, starts the animation; when false, stops it
 *   startedAt   — server epoch-ms when the hand started; the curve is
 *                 aligned to it so every client renders the same
 *                 multiplier at the same wall-clock moment
 *   curveFrom   — multiplier the current flight segment starts from
 *                 (1.00 at hand start, or the checkpoint multiplier after
 *                 a betting window closes)
 *   curveResumedAt — server epoch-ms the current flight segment started
 *                 (hand start, or the moment the last checkpoint closed)
 *   curveCap    — multiplier to HOLD at while a betting window is open
 *                 (null = free climb); the flight pauses here until the
 *                 window resolves
 *   onFrame     — called every ~80ms with { multiplier, points, crashed }
 *   onCrash     — called when the crash happens (autonomous or triggered)
 */
export default function useCrashAnimation({
  crashPoint,
  running = false,
  startedAt = null,
  curveFrom = 1,
  curveResumedAt = null,
  curveCap = null,
  onFrame,
  onCrash,
}) {
  const rafRef = useRef(null);

  const stateRef = useRef({
    startTime: 0,
    // Pause-aware curve segment bookkeeping: which server flight segment
    // this client is currently rendering (its epoch-ms anchor + the
    // multiplier it starts from). Re-anchored live whenever the server
    // resumes the flight after a betting window closes.
    segmentAnchorMs: 0,
    segmentStartTime: 0,
    segmentFrom: 1,
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

  // Live curve-segment props (pause-aware). The animation loop reads these
  // every frame, so a betting window opening (cap set) or closing (resumedAt
  // advancing) takes effect WITHOUT restarting the animation.
  const curveRef = useRef({ from: 1, resumedAt: null, cap: null });
  useEffect(() => {
    curveRef.current = { from: curveFrom, resumedAt: curveResumedAt, cap: curveCap };
  }, [curveFrom, curveResumedAt, curveCap]);

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

    // Align the curve to the server's flight segment start (epoch ms): the
    // animation begins `elapsed` ms into the curve instead of at t=0, so a
    // client that received the broadcast late still renders the same
    // multiplier everyone else sees at that moment. The segment anchor is
    // the hand's flightResumedAt (= startedAt at hand start); it advances
    // live when a pause window closes. NOTE: the anchor may lie in the
    // FUTURE (the new-round hint window — the server delays startedAt), so
    // this client's start time is set in the future too; the elapsed clamp
    // in the loop pins the curve at 1.00x until the anchor is reached.
    const startedAtMs = Number(startedAtRef.current) || 0;
    const anchorMs = Number(curveRef.current.resumedAt) || startedAtMs || 0;
    const startTime = anchorMs
      ? performance.now() + (anchorMs - Date.now())
      : performance.now();

    stateRef.current = {
      startTime,
      segmentAnchorMs: anchorMs,
      segmentStartTime: startTime,
      segmentFrom: Number(curveRef.current.from) || 1,
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
      const c = curveRef.current;

      // Segment re-anchor: the server resumed the flight at a NEW moment
      // (a fold-pause window closed → flightResumedAt advanced, or the hand
      // started with a future anchor). Restart the curve from the frozen
      // multiplier at that moment instead of continuing from the hand
      // start — otherwise the paused time would inflate the multiplier. The
      // new anchor may lie in the FUTURE (hint window) — elapsed is clamped
      // in the loop so the curve holds 1.00x until it is reached.
      const anchorMs = Number(c.resumedAt) || Number(startedAtRef.current) || 0;
      if (anchorMs && s.segmentAnchorMs !== anchorMs) {
        s.segmentAnchorMs = anchorMs;
        s.segmentStartTime = performance.now() + (anchorMs - Date.now());
        s.segmentFrom = Number(c.from) || 1;
      }

      const elapsedSeconds = Math.max(0, (now - s.segmentStartTime) / 1000);
      // Piecewise-linear slowdown: climb from this segment's start
      // multiplier, but on the SHARED curve — the elapsed time here is
      // relative to the segment's own anchor (hand start, or the moment a
      // fold-pause window closed), and the segment's start multiplier is a
      // point ON that curve, so we translate it back to curve-seconds and
      // read the curve forward from there.
      let deterministicMultiplier =
        crashMultiplierAtTime(
          timeToCrashMultiplier(s.segmentFrom) + elapsedSeconds,
        );
      // Pause at an open betting checkpoint: hold the multiplier at the
      // cap while the window is open — the curve stops at every 0.25x
      // increment so players can decide without the rocket racing away.
      if (c.cap != null && deterministicMultiplier >= c.cap) {
        deterministicMultiplier = c.cap;
      }
      const roundedMultiplier = parseFloat(deterministicMultiplier.toFixed(4));
      // Autonomous crash detection only when the engine knows the point.
      // With an unknown point (Crash Poker) the curve flies until the
      // server announces the crash — the engine never decides it. Never
      // crash while paused at a checkpoint: the sweep would have crashed
      // the hand before ever opening a window beyond the crash point.
      const hasKnownCrashPoint = s.crashPoint > 0;
      const didCrash =
        hasKnownCrashPoint &&
        c.cap == null &&
        roundedMultiplier >= s.crashPoint;

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
