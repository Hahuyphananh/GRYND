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
      // `tabular-nums` gives every digit the same advance width, so the
      // centred number stops micro-shifting sideways as its digits change
      // 12×/s — the text reads as one steady value climbing rather than a
      // jittering label. No scale/pulse/extra glow: this is the primary
      // read-out, so it stays still and legible while the curve moves.
      //
      // Crashed state: one 240ms stamp (crashStamp) + a red gradient, then the
      // read-out sits still — the crash is the biggest moment in the hand, so
      // it gets one beat, not a permanent animation.
      className={`relative text-4xl sm:text-5xl font-extrabold z-30 mt-8 sm:mt-12 tracking-wider tabular-nums
text-transparent bg-clip-text
bg-gradient-to-r
${
  isCrashed
    ? "animate-crash-stamp from-[#ff8080] via-[#ef4444] to-[#ff9f43] drop-shadow-[0_0_22px_rgba(239,68,68,0.85)]"
    : "from-[#00e5ff] via-[#00ffa6] to-[#FFD700] drop-shadow-[0_0_20px_rgba(0,229,255,0.8)]"
} ${className}`}
    >
      {isCrashed ? "CRASHED!" : `${multiplier.toFixed(2)}x`}
      {/* The final multiplier stays on screen instead of being replaced by the
          label. Absolutely positioned so the read-out keeps exactly the height
          it had while flying, and its own colour because the parent clips a
          text-transparent gradient. */}
      {isCrashed && (
        <span className="absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap text-lg sm:text-xl font-black tracking-[0.2em] text-red-300">
          at {multiplier.toFixed(2)}x
        </span>
      )}
    </div>
  );
}
