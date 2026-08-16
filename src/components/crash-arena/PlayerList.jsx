"use client";
import React from "react";
import { IconBomb, IconCircleCheck, IconFlag } from "@tabler/icons-react";

/**
 * PlayerList — shows seated players at an arena table with live round status.
 *
 * Props:
 *   players  — array of { name, avatar?, balance, isYou?, isSittingOut?,
 *                        cashoutMultiplier?, busted?, isPlaying? }
 *   maxSeats — total seats at the table
 *   phase    — current round phase ("waiting" | "running" | "crashed" | "settling")
 *   onReport — (player) => void — opens the report modal for a seated opponent
 */
export default function PlayerList({ players = [], maxSeats = 6, phase = "waiting", onReport }) {
  const seats = Array.from({ length: maxSeats }, (_, i) => players[i] || null);
  const isLive = phase === "running" || phase === "crashed" || phase === "settling";

  /** Derive the border + glow treatment for a player card during live rounds. */
  function cardStyle(player) {
    if (!player) return "border-dashed border-[#00e5ff]/10 bg-transparent opacity-40";
    if (player.isSittingOut) return "border-yellow-500/30 bg-[#020617] opacity-60";
    if (player.busted) return "border-red-500/40 bg-red-950/30 shadow-[0_0_12px_rgba(239,68,68,0.25)]";
    if (player.cashoutMultiplier != null) return "border-[#00ffa6]/40 bg-[#00ffa6]/5 shadow-[0_0_12px_rgba(0,255,166,0.25)]";
    if (player.isPlaying && isLive) return "border-[#00e5ff]/40 bg-[#020617] shadow-[0_0_12px_rgba(0,229,255,0.18)] animate-pulse";
    return "border-[#00e5ff]/30 bg-[#020617] shadow-[0_0_12px_rgba(0,229,255,0.1)]";
  }

  return (
    <div className="flex flex-wrap gap-2 justify-center">
      {seats.map((player, i) => {
        // Determine the live-status badge
        let liveBadge = null;
        if (player && isLive && !player.isSittingOut) {
          if (player.cashoutMultiplier != null && !player.busted) {
            liveBadge = (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#00ffa6]/15 text-[#00ffa6] border border-[#00ffa6]/30 font-bold">
                <IconCircleCheck size={12} className="mr-1 inline" /> {player.cashoutMultiplier.toFixed(2)}x
              </span>
            );
          } else if (player.busted) {
            liveBadge = (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/30 font-bold">
                <IconBomb size={12} className="mr-1 inline" /> Busted
              </span>
            );
          } else if (player.isPlaying) {
            liveBadge = (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#00e5ff]/10 text-[#00e5ff]/80 border border-[#00e5ff]/20 animate-pulse">
                In flight…
              </span>
            );
          }
        }

        return (
          <div
            key={i}
            className={`flex flex-col items-center gap-1 p-2 rounded-xl border min-w-[85px] transition-all duration-300 ${cardStyle(player)}`}
          >
            {/* Avatar */}
            <div
              className={`relative w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold border-2
                ${player
                  ? player.isYou
                    ? "border-[#FFD700] bg-[#FFD700]/25 text-[#FFD700] ring-2 ring-[#FFD700]/40"
                    : player.busted
                      ? "border-red-500/50 bg-red-500/15 text-red-400"
                      : player.cashoutMultiplier != null
                        ? "border-[#00ffa6]/50 bg-[#00ffa6]/15 text-[#00ffa6]"
                        : "border-[#00e5ff]/40 bg-[#00e5ff]/15 text-[#00e5ff]"
                  : "border-gray-500/20 bg-transparent text-gray-500"
                }`}
            >
              {player ? (player.name?.charAt(0)?.toUpperCase() || "?") : i + 1}
              {/* You badge */}
              {player?.isYou && (
                <span className="absolute -bottom-1 -right-1 text-[8px] px-1 py-0.5 rounded-full bg-[#FFD700] text-black font-black">
                  YOU
                </span>
              )}
            </div>

            {/* Name */}
            <span className={`text-xs font-semibold truncate max-w-[75px] ${player ? "text-[#d8fbff]" : "text-gray-500"}`}>
              {player ? player.name : "Empty"}
            </span>

            {/* Balance */}
            {player && (
              <span className="text-[10px] text-[#00ffa6] font-bold">
                ${player.balance?.toLocaleString() || 0}
              </span>
            )}

            {/* Sitting out badge */}
            {player?.isSittingOut && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 border border-yellow-500/30">
                SITTING OUT
              </span>
            )}

            {/* Live round badge (cashout / busted / in-flight) */}
            {liveBadge}

            {/* Report flag — lets a seated player report any opponent at
                the table. Hidden on the player's own seat and on empty
                seats; only wired up when the parent passes onReport. */}
            {player && !player.isYou && onReport && (
              <button
                onClick={() => onReport(player)}
                title={`Report ${player.name || "this player"}`}
                aria-label={`Report ${player.name || "this player"}`}
                className="mt-0.5 px-1.5 py-0.5 rounded-md border border-red-500/30 bg-red-500/10 text-[10px] font-bold text-red-400 transition-all hover:bg-red-500/25 hover:shadow-[0_0_8px_rgba(239,68,68,0.35)]"
              >
                <IconFlag size={13} />
              </button>
            )}

            {/* Legacy status badges (for non-live phases) */}
            {!isLive && player?.status === "cashed_out" && !player.isSittingOut && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[#00ffa6]/15 text-[#00ffa6] border border-[#00ffa6]/30">
                CASHED OUT
              </span>
            )}
            {!isLive && player?.status === "crashed" && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/30">
                <IconBomb size={12} className="mr-1 inline" /> CRASHED
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
