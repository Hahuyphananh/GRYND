"use client";
import React, { useRef, useImperativeHandle, forwardRef } from "react";
import { CRASH_CURVE_MAX_TIME, timeToCrashMultiplier } from "../../../lib/games/crash/constants";

// ── Drawing constants ──────────────────────────────────────────────────
export const CANVAS_WIDTH = 800;
export const CANVAS_HEIGHT = 600;
export const GRAPH_PADDING = 40;
// Y-axis upper bound when the crash point is unknown to the client
// (Crash Poker hides it until the crash) — high enough that any crash
// point within the game's range (max 9.2x) stays on the chart.
export const DEFAULT_MAX_MULTIPLIER = 10;
// Per-draw darkening of the previous frame, which is what leaves the curve its
// comet trail. The fade is per DRAW, so the value has to track the draw rate:
// 0.12 at the old 12.5fps (UI-throttled) redraw ≈ 0.026 at 60fps, giving the
// same ~0.7s of visible trail instead of one that persists noticeably longer.
export const TRAIL_FADE_ALPHA = 0.026;

// ── Helpers (module-scoped for use in imperative draw) ─────────────────

function getCurveColor(mult) {
  if (mult < 2) return "#22c55e";
  if (mult < 5) return "#facc15";
  return "#ef4444";
}

function drawGrid(ctx, w, h, pad) {
  ctx.save();
  ctx.strokeStyle = "rgba(148, 163, 184, 0.18)";
  ctx.lineWidth = 1;
  for (let x = pad; x <= w - pad; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, pad);
    ctx.lineTo(x, h - pad);
    ctx.stroke();
  }
  for (let y = pad; y <= h - pad; y += 40) {
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSmoothCurve(ctx, points, mult, w, h, pad) {
  if (points.length < 2) return;
  const gradient = ctx.createLinearGradient(0, h, w, 0);
  gradient.addColorStop(0, "#22c55e");
  gradient.addColorStop(0.55, "#facc15");
  gradient.addColorStop(1, "#ef4444");

  ctx.strokeStyle = gradient;
  ctx.lineWidth = 4;
  ctx.shadowColor = getCurveColor(mult);
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);

  for (let i = 1; i < points.length - 1; i += 1) {
    const xc = (points[i].x + points[i + 1].x) / 2;
    const yc = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
  }

  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function drawCrashExplosion(ctx, point, progress) {
  if (!point) return;
  const radius = 20 + progress * 70;
  const alpha = Math.max(0, 0.75 - progress * 0.75);
  const explosionGradient = ctx.createRadialGradient(
    point.x,
    point.y,
    0,
    point.x,
    point.y,
    radius,
  );
  explosionGradient.addColorStop(0, `rgba(239, 68, 68, ${alpha})`);
  explosionGradient.addColorStop(0.4, `rgba(239, 68, 68, ${alpha * 0.5})`);
  explosionGradient.addColorStop(1, "rgba(239, 68, 68, 0)");
  ctx.fillStyle = explosionGradient;
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function toCanvasPoint(mult, maxMultiplier, w, h, pad) {
  const maxX = w - pad;
  const minX = pad;
  const maxY = h - pad;
  const minY = pad;

  const elapsed = timeToCrashMultiplier(mult);
  // X-axis time span (seconds): the curve's full timeline (~100.5s to the
  // 9.2x ceiling) — plus ~20% headroom so the rocket never sits pinned at
  // the right edge before it explodes.
  const MAX_TIME = 120;
  const progress = Math.min(elapsed / MAX_TIME, 1);
  const x = minX + progress * (maxX - minX);

  const normalized = (mult - 1) / (maxMultiplier - 1);
  const y = maxY - Math.max(0, Math.min(1, normalized)) * (maxY - minY);

  return { x, y };
}

// ── Public helpers (also exported for use by animation hook) ───────────

export { getCurveColor, toCanvasPoint };

// ── Component ──────────────────────────────────────────────────────────

/**
 * CrashGraph — imperative canvas renderer for the Crash curve.
 *
 * Props:
 *   width, height   — canvas dimensions (default: CANVAS_WIDTH / CANVAS_HEIGHT)
 *   maxMultiplier   — upper bound for Y-axis labels and coordinate mapping
 *   className       — forwarded to <canvas>
 *
 * Ref API (useImperativeHandle):
 *   draw(state, now)
 *     state: { curvePoints, currentMultiplier, crashed, crashAt, crashCanvasPoint,
 *              explosionProgress, reduced }
 *     now:   performance.now() timestamp
 *     `reduced` (prefers-reduced-motion) keeps the curve — it IS the game
 *     state — but drops the decorative layers: no ghost trail (a clean
 *     redraw each frame) and no crash bloom.
 *
 *   reset()
 *     clears the canvas and draws initial empty grid
 */
const CrashGraph = forwardRef(function CrashGraph(
  { width = CANVAS_WIDTH, height = CANVAS_HEIGHT, maxMultiplier = 2, className },
  ref,
) {
  const canvasRef = useRef(null);

  useImperativeHandle(ref, () => ({
    draw(state, now) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      if (!state || state.curvePoints.length <= 1) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "rgba(2, 6, 23, 1)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        drawGrid(ctx, width, height, GRAPH_PADDING);
        return;
      }

      if (state.reduced) {
        // Clean single curve: repaint the backdrop instead of veiling it, so
        // no ghost fan accumulates behind the rocket.
        ctx.fillStyle = "rgba(2, 6, 23, 1)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      } else {
        ctx.fillStyle = `rgba(2, 6, 23, ${TRAIL_FADE_ALPHA})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      drawGrid(ctx, width, height, GRAPH_PADDING);
      drawSmoothCurve(ctx, state.curvePoints, state.currentMultiplier, width, height, GRAPH_PADDING);

      // Draw head dot
      const last = state.curvePoints[state.curvePoints.length - 1];
      ctx.fillStyle = getCurveColor(state.currentMultiplier);
      ctx.shadowColor = getCurveColor(state.currentMultiplier);
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(last.x, last.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // Crash explosion — the expanding bloom is decorative, so reduced
      // motion skips it and leaves the frozen curve at its crash point.
      if (state.crashed && state.crashCanvasPoint && !state.reduced) {
        const progress = Math.min((now - (state.crashAt || now)) / 700, 1);
        state.explosionProgress = progress;
        drawCrashExplosion(ctx, state.crashCanvasPoint, progress);
      }
    },

    reset() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "rgba(2, 6, 23, 1)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawGrid(ctx, width, height, GRAPH_PADDING);
    },
  }));

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className={className}
    />
  );
});

export default CrashGraph;
