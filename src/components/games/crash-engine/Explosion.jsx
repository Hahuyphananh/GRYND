"use client";
import React from "react";

/**
 * Explosion — shows the 💥 emoji when the game has crashed.
 *
 * Props:
 *   isCrashed  — whether to show the explosion
 *   className  — forwarded to wrapper div
 */
export default function Explosion({ isCrashed = false, className = "" }) {
  if (!isCrashed) return null;

  return (
    <div className={`absolute top-20 text-6xl ${className}`}>
      💥
    </div>
  );
}
