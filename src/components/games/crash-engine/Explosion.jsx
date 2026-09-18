"use client";
import React from "react";
import { IconBomb } from "@tabler/icons-react";
import { CANVAS_WIDTH, CANVAS_HEIGHT, GRAPH_PADDING } from "./CrashGraph";

/**
 * Explosion — the crash bomb graphic, placed where the curve actually died.
 *
 * Props:
 *   isCrashed        — whether to show the explosion
 *   crashCanvasPoint — { x, y } of the crash in CrashGraph's canvas
 *                      coordinates. Optional: without it the bomb falls back
 *                      to its original resting spot (a caller that only
 *                      knows "crashed").
 *   className        — forwarded to wrapper div
 */
export default function Explosion({
  isCrashed = false,
  crashCanvasPoint = null,
  className = "",
}) {
  if (!isCrashed) return null;

  // Anchored in percentages of the canvas box, so nothing has to measure the
  // container and the bomb lands on the crash point at every table size. The
  // anchor is clamped inside the plot area (the game area clips its overflow)
  // so a high-multiplier crash can't leave the 72px bomb half cut off by the
  // frame, and it is clamped short of the curve's own head so the two don't
  // sit exactly on top of each other.
  const anchored =
    crashCanvasPoint != null &&
    Number.isFinite(crashCanvasPoint.x) &&
    Number.isFinite(crashCanvasPoint.y);
  const clamp = (value, max) =>
    Math.min(Math.max(value, GRAPH_PADDING + 40), max - GRAPH_PADDING - 40);

  return (
    <div
      className={`absolute ${anchored ? "" : "top-20"} ${className}`}
      style={
        anchored
          ? {
              left: `${(clamp(crashCanvasPoint.x, CANVAS_WIDTH) / CANVAS_WIDTH) * 100}%`,
              top: `${(clamp(crashCanvasPoint.y, CANVAS_HEIGHT) / CANVAS_HEIGHT) * 100}%`,
              transform: "translate(-50%, -50%)",
            }
          : undefined
      }
    >
      {/* Inner element carries the punch-in (crashImpact), so the animation's
          scale can never fight the wrapper's centring translate. One-shot —
          the bomb then sits still over the frozen curve. */}
      <span className="animate-crash-impact inline-block">
        <IconBomb
          size={72}
          className="text-red-500 drop-shadow-[0_0_24px_rgba(239,68,68,0.9)]"
        />
      </span>
    </div>
  );
}
