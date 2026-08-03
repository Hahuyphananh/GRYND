"use client";
import React from "react";

/**
 * RoundStatus — displays the current round state banner.
 *
 * Props:
 *   status       — "waiting" | "starting" | "flying" | "crashed" | "finished"
 *   roundNumber  — current round number
 *   crashedAt    — multiplier where crash happened (if crashed)
 */
const STATUS_CONFIG = {
  waiting:   { label: "Waiting for players...", color: "text-[#9dd8ff]",   bg: "bg-[#9dd8ff]/10", border: "border-[#9dd8ff]/25" },
  starting:  { label: "Round starting!",         color: "text-[#FFD700]",  bg: "bg-[#FFD700]/10",  border: "border-[#FFD700]/30", pulse: true },
  flying:    { label: "In flight 🚀",            color: "text-[#00ffa6]",  bg: "bg-[#00ffa6]/10",  border: "border-[#00ffa6]/30", pulse: true },
  crashed:   { label: "💥 CRASHED!",             color: "text-red-400",    bg: "bg-red-500/10",     border: "border-red-500/30" },
  finished:  { label: "Round over",              color: "text-[#9dd8ff]",  bg: "bg-[#9dd8ff]/10",  border: "border-[#9dd8ff]/25" },
};

export default function RoundStatus({ status = "waiting", roundNumber = 1, crashedAt = null }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.waiting;

  return (
    <div
      className={`flex items-center gap-3 px-4 py-2 rounded-xl border ${config.border} ${config.bg} transition-all duration-300`}
    >
      {/* Round number badge */}
      <div className="flex-shrink-0 w-10 h-10 rounded-full bg-[#FFD700]/15 border border-[#FFD700]/30 flex items-center justify-center text-[#FFD700] font-black text-sm">
        R{roundNumber}
      </div>

      {/* Status text */}
      <div className="flex flex-col">
        <span className={`text-sm font-bold ${config.color} ${config.pulse ? "animate-pulse" : ""}`}>
          {config.label}
        </span>
        {status === "crashed" && crashedAt !== null && (
          <span className="text-xs text-red-400/70">at {crashedAt.toFixed(2)}x</span>
        )}
      </div>
    </div>
  );
}
