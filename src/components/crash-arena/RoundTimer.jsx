"use client";
import React, { useEffect, useState } from "react";
import { playTick } from "../../lib/gameAudio";

/**
 * RoundTimer — countdown to the next round start.
 *
 * Props:
 *   seconds    — seconds until next round
 *   isRunning  — whether the countdown is active
 *   onExpire   — called when timer reaches 0
 *   label      — caption above the countdown (default "Next Round")
 */
export default function RoundTimer({ seconds = 30, isRunning = false, onExpire, label = "Next Round" }) {
  const [remaining, setRemaining] = useState(seconds);

  useEffect(() => {
    setRemaining(seconds);
  }, [seconds]);

  useEffect(() => {
    if (!isRunning || remaining <= 0) return;
    // Countdown tick every second so the pending round is audible.
    // (The effect re-runs each second as `remaining` changes, so the
    // tick lives in the interval callback — not the effect body —
    // to avoid double-firing.)
    const timer = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          onExpire?.();
          return 0;
        }
        playTick();
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [isRunning, remaining, onExpire]);

  const isUrgent = remaining <= 5 && remaining > 0;

  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-xs uppercase tracking-widest text-[#9dd8ff]/70">{label}</span>
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
