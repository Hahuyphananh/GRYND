"use client";
import React from "react";

/**
 * CrashMultiplier — displays the current multiplier or "CRASHED!" state.
 *
 * Props:
 *   multiplier  — current multiplier value (number)
 *   isCrashed   — whether the game has crashed
 *   className   — forwarded to wrapper div
 */
export default function CrashMultiplier({ multiplier = 1.0, isCrashed = false, className = "" }) {
  return (
    <div
      className={`text-5xl font-extrabold z-30 mt-12 tracking-wider
text-transparent bg-clip-text
bg-gradient-to-r from-[#00e5ff] via-[#00ffa6] to-[#FFD700]
drop-shadow-[0_0_20px_rgba(0,229,255,0.8)] ${className}`}
    >
      {isCrashed ? "CRASHED!" : `${multiplier.toFixed(2)}x`}
    </div>
  );
}
