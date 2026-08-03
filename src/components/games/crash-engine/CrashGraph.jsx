"use client";
import React, { useRef, useImperativeHandle, forwardRef } from "react";

// ── Drawing constants ──────────────────────────────────────────────────
export const CANVAS_WIDTH = 800;
export const CANVAS_HEIGHT = 600;
export const GRAPH_PADDING = 40;
export const GROWTH_RATE = 0.33;
export const TRAIL_FADE_ALPHA = 0.12;

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

  const elapsed = Math.log(Math.max(mult, 1.0001)) / GROWTH_RATE;
  const MAX_TIME = 8;
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
 *     state: { curvePoints, currentMultiplier, crashed, crashAt, crashCanvasPoint, explosionProgress }
 *     now:   performance.now() timestamp
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

      ctx.fillStyle = `rgba(2, 6, 23, ${TRAIL_FADE_ALPHA})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

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

      // Crash explosion
      if (state.crashed && state.crashCanvasPoint) {
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
