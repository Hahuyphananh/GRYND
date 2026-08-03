"use client";
import React, { useEffect, useState } from "react";

/**
 * RoundTimer — countdown to the next round start.
 *
 * Props:
 *   seconds    — seconds until next round
 *   isRunning  — whether the countdown is active
 *   onExpire   — called when timer reaches 0
 */
export default function RoundTimer({ seconds = 30, isRunning = false, onExpire }) {
  const [remaining, setRemaining] = useState(seconds);

  useEffect(() => {
    setRemaining(seconds);
  }, [seconds]);

  useEffect(() => {
    if (!isRunning || remaining <= 0) return;
    const timer = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          onExpire?.();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [isRunning, remaining, onExpire]);

  const isUrgent = remaining <= 5 && remaining > 0;

  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-xs uppercase tracking-widest text-[#9dd8ff]/70">Next Round</span>
      <div
        className={`text-4xl font-black tabular-nums transition-all duration-300
          ${isRunning && isUrgent
            ? "text-red-400 animate-pulse drop-shadow-[0_0_15px_rgba(248,113,113,0.6)]"
            : "text-[#00e5ff] drop-shadow-[0_0_10px_rgba(0,229,255,0.4)]"
          }`}
      >
        {remaining > 0 ? `0:${String(remaining).padStart(2, "0")}` : "NOW"}
      </div>
    </div>
  );
}
