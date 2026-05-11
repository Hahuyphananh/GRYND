"use client";
import React from "react";

export default function PlayerList({
  hasBet,
  betAmount,
  cashedOut,
  multiplier,
}) {
  return (
    <div className="relative w-full">
      {/* Neon top line */}
      <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-[#ff4fd8] to-transparent opacity-80"></div>

      <div
        className="bg-[#050d1f]/80 backdrop-blur-xl border border-[#ff4fd8]/40 
                    shadow-[0_0_25px_rgba(255,79,216,0.25),inset_0_0_25px_rgba(255,79,216,0.08)]
                    p-6 rounded-2xl flex flex-col gap-4 w-full"
      >
        {/* Title */}
        <h2
          className="text-2xl font-extrabold tracking-wider text-transparent bg-clip-text 
                     bg-gradient-to-r from-[#ff4fd8] to-[#00e5ff] drop-shadow-[0_0_10px_rgba(255,79,216,0.6)]"
        >
          🎮 MY BET
        </h2>

        {!hasBet ? (
          <div className="text-gray-400 text-sm border border-white/10 bg-black/20 p-3 rounded-xl">
            No active bets
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* Bet amount */}
            <div
              className="flex items-center justify-between px-3 py-2 rounded-xl 
                          border border-[#00e5ff]/30 bg-[#020617] 
                          shadow-[0_0_10px_rgba(0,229,255,0.15)]"
            >
              <span className="text-gray-300">💵 Bet Amount</span>
              <span className="text-[#00e5ff] font-bold">${betAmount}</span>
            </div>

            {/* Status */}
            <div
              className="flex items-center justify-between px-3 py-2 rounded-xl 
                          border border-[#ff4fd8]/30 bg-[#020617]
                          shadow-[0_0_10px_rgba(255,79,216,0.15)]"
            >
              <span className="text-gray-300">Status</span>

              {cashedOut ? (
                <span
                  className="text-green-400 font-bold 
                               drop-shadow-[0_0_10px_rgba(0,255,120,0.6)]"
                >
                  ✅ {multiplier.toFixed(2)}x
                </span>
              ) : (
                <span
                  className="text-yellow-400 font-bold 
                               animate-pulse"
                >
                  WAITING...
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
