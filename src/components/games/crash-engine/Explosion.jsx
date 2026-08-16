"use client";
import React from "react";
import { IconBomb } from "@tabler/icons-react";

/**
 * Explosion — shows the crash bomb graphic when the game has crashed.
 *
 * Props:
 *   isCrashed  — whether to show the explosion
 *   className  — forwarded to wrapper div
 */
export default function Explosion({ isCrashed = false, className = "" }) {
  if (!isCrashed) return null;

  return (
    <div className={`absolute top-20 ${className}`}>
      <IconBomb
        size={72}
        className="text-red-500 drop-shadow-[0_0_24px_rgba(239,68,68,0.9)]"
      />
    </div>
  );
}
