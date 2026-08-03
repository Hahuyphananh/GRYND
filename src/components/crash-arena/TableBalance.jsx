"use client";
import React from "react";

/**
 * TableBalance — shows a player's chip balance at the table.
 *
 * Props:
 *   balance  — current chip balance
 *   label    — label text (default "Your Chips")
 */
export default function TableBalance({ balance = 0, label = "Your Chips" }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 rounded-xl border border-[#00e5ff]/25 bg-[#020617] shadow-[0_0_12px_rgba(0,229,255,0.1)]">
      <div className="flex flex-col">
        <span className="text-[10px] uppercase tracking-wider text-[#9dd8ff]/60">{label}</span>
        <span className="text-lg font-black text-[#00e5ff] drop-shadow-[0_0_8px_rgba(0,229,255,0.6)]">
          ${balance.toLocaleString()}
        </span>
      </div>
      <div className="w-8 h-8 rounded-full bg-[#FFD700]/20 border border-[#FFD700]/40 flex items-center justify-center text-[#FFD700] text-sm">
        🪙
      </div>
    </div>
  );
}
