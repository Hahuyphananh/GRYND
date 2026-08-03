"use client";
import React from "react";
import Link from "next/link";

/**
 * TableCard — a single table card in the Crash Arena lobby grid.
 * Now uses Next.js Link to navigate to /casino/crash-arena/table/[id].
 *
 * Props:
 *   table     — { id, name, wager, minBuyIn, players, pot, maxPlayers, status }
 *   className — forwarded
 */
export default function TableCard({ table, className = "" }) {
  const { id, name, wager, minBuyIn, players = [], pot = 0, maxPlayers = 6, status } = table;
  const seatsFilled = players.length;
  const isFull = seatsFilled >= maxPlayers;
  const isPlaying = status === "flying" || status === "starting";

  const href = isFull ? "#" : `/casino/crash-arena/table/${id}`;

  return (
    <Link
      href={href}
      className={`block group relative overflow-hidden rounded-2xl border transition-all duration-300 hover:-translate-y-1 hover:scale-[1.02]
        ${isPlaying
          ? "border-[#00ffa6]/40 bg-[#041a0d] hover:shadow-[0_0_30px_rgba(0,255,166,0.35)]"
          : isFull
            ? "border-gray-500/30 bg-[#0d0d1a] pointer-events-none opacity-75"
            : "border-[#00e5ff]/35 bg-[#040d24] hover:shadow-[0_0_30px_rgba(0,229,255,0.4)]"
        }
        ${className}`}
    >
      {/* Top accent line */}
      <div
        className={`absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent opacity-70
          ${isPlaying ? "!via-[#00ffa6]" : ""}`}
      />

      <div className="p-5 flex flex-col gap-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs uppercase tracking-widest text-[#9dd8ff] opacity-70">
              Round Wager
            </span>
            <div className="text-2xl font-black text-[#FFD700] drop-shadow-[0_0_8px_rgba(255,215,0,0.4)]">
              ${wager}
            </div>
          </div>
          <div
            className={`px-3 py-1 rounded-full text-xs font-bold border
              ${isPlaying
                ? "bg-[#00ffa6]/15 text-[#00ffa6] border-[#00ffa6]/40 animate-pulse"
                : isFull
                  ? "bg-gray-500/15 text-gray-400 border-gray-500/30"
                  : "bg-[#00e5ff]/15 text-[#00e5ff] border-[#00e5ff]/40"
              }`}
          >
            {isPlaying ? "LIVE" : isFull ? "FULL" : "OPEN"}
          </div>
        </div>

        {/* Table name */}
        <div className="text-sm font-bold text-[#d8fbff]">{name}</div>

        {/* Stats row */}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex flex-col">
            <span className="text-[#9dd8ff]/60 text-xs">Min Buy-in</span>
            <span className="text-[#d8fbff] font-semibold">${minBuyIn}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-[#9dd8ff]/60 text-xs">Pot</span>
            <span className="text-[#00ffa6] font-bold drop-shadow-[0_0_6px_rgba(0,255,166,0.3)]">
              ${pot.toLocaleString()}
            </span>
          </div>
        </div>

        {/* Players row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className="text-[#9dd8ff]/60 text-xs">Players</span>
            <div className="flex -space-x-2">
              {players.slice(0, 4).map((p, i) => (
                <div
                  key={i}
                  className="w-7 h-7 rounded-full border-2 border-[#040d24] bg-[#00e5ff]/30 flex items-center justify-center text-[10px] font-bold text-white"
                  title={p.name}
                >
                  {p.name?.charAt(0)?.toUpperCase() || "?"}
                </div>
              ))}
              {players.length > 4 && (
                <div className="w-7 h-7 rounded-full border-2 border-[#040d24] bg-[#08142f] flex items-center justify-center text-[10px] font-bold text-[#9dd8ff]">
                  +{players.length - 4}
                </div>
              )}
            </div>
          </div>
          <span className="text-[#9dd8ff]/60 text-xs">{seatsFilled}/{maxPlayers}</span>
        </div>

        {/* Join button */}
        <div
          className={`mt-1 w-full py-2.5 rounded-xl font-bold text-sm text-center transition-all duration-300
            ${isPlaying
              ? "bg-gradient-to-r from-[#00ffa6]/20 to-[#00e5ff]/20 text-[#00ffa6] border border-[#00ffa6]/30"
              : isFull
                ? "bg-gray-700/30 text-gray-500 border border-gray-600/20"
                : "bg-gradient-to-r from-[#00e5ff]/20 to-[#007cf0]/20 text-[#00e5ff] border border-[#00e5ff]/30 group-hover:from-[#00e5ff]/35 group-hover:to-[#007cf0]/35"
            }`}
        >
          {isPlaying ? "Spectate" : isFull ? "Table Full" : "Join Table"}
        </div>
      </div>
    </Link>
  );
}
