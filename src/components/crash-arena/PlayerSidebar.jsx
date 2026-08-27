"use client";
import React from "react";
import {
  IconArmchair,
  IconBomb,
  IconCircleCheck,
  IconClock,
  IconFlag,
  IconHome,
  IconMoodSilence,
  IconRocket,
  IconUsers,
} from "@tabler/icons-react";

/**
 * PlayerSidebar — poker-style player panel shown beside the game canvas.
 *
 * Lists every seated player with a live status treatment (cashed out /
 * busted / in flight) and, underneath, any wait-listed players. The whole
 * panel is toggled on/off from the table top bar.
 *
 * Props:
 *   players       — seated players from roundState
 *   waitingPlayers — wait-listed players from roundState
 *   phase         — current round phase
 *   maxPlayers    — table seat capacity (defaults to 6)
 *   onExitToLobby — () => void — for a wait-listed player to cash out
 *                   and return to the lobby
 */
export default function PlayerSidebar({
  players = [],
  waitingPlayers = [],
  phase = "waiting",
  maxPlayers = 6,
  onExitToLobby,
}) {
  const isLive = phase === "running" || phase === "crashed" || phase === "settling";

  const statusOf = (p) => {
    if (p.isSittingOut) return { label: "Sitting out", cls: "text-yellow-400", icon: <IconMoodSilence size={13} className="inline" /> };
    if (p.allIn) return { label: "All-in", cls: "text-[#ff4fd8]", icon: <IconCircleCheck size={13} className="inline" /> };
    if (p.folded) return { label: "Folded", cls: "text-yellow-400", icon: <IconFlag size={13} className="inline" /> };
    if (p.busted) return { label: "Busted", cls: "text-red-400", icon: <IconBomb size={13} className="inline" /> };
    if (p.cashoutMultiplier != null) {
      return { label: `${p.cashoutMultiplier.toFixed(2)}x`, cls: "text-[#00ffa6]", icon: <IconCircleCheck size={13} className="inline" /> };
    }
    if (isLive && p.isActive) return { label: "In hand…", cls: "text-[#00e5ff]", icon: <IconRocket size={13} className="inline" /> };
    if (isLive && p.isPlaying && !p.isActive) return { label: "Not in hand", cls: "text-[#9dd8ff]/60", icon: <IconArmchair size={13} className="inline" /> };
    return { label: "Waiting", cls: "text-[#9dd8ff]/70", icon: <IconArmchair size={13} className="inline" /> };
  };

  return (
    <div className="flex w-full max-h-[70vh] lg:w-60 lg:max-h-[560px] shrink-0 flex-col gap-2 overflow-y-auto rounded-2xl border border-[#ff4fd8]/25 bg-[#040d24]/60 p-3 backdrop-blur-sm">
      <h3 className="flex items-center justify-center gap-1.5 text-xs uppercase tracking-wider text-[#ff4fd8]/70">
        <IconUsers size={14} className="mr-1" /> Players
        <span className="rounded-full border border-[#ff4fd8]/30 bg-[#ff4fd8]/10 px-1.5 py-0.5 text-[10px] font-black text-[#ff4fd8]">
          {players.length}/{maxPlayers}
        </span>
      </h3>

      {players.length === 0 && (
        <p className="text-xs text-[#9dd8ff]/50 text-center py-3">No one at the table yet.</p>
      )}

      {players.map((p) => {
        const s = statusOf(p);
        return (
          <div
            key={p.userId ?? p.name}
            className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-all duration-300 ${
              p.busted
                ? "bg-red-500/10 border border-red-500/20"
                : p.cashoutMultiplier != null
                  ? "bg-[#00ffa6]/10 border border-[#00ffa6]/20"
                  : "bg-[#00e5ff]/5 border border-[#00e5ff]/10"
            }`}
          >
            <span
              className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-black border shrink-0 ${
                p.isYou
                  ? "bg-[#FFD700]/25 border-[#FFD700] text-[#FFD700]"
                  : "bg-[#020617] border-[#00e5ff]/30 text-[#9dd8ff]"
              }`}
            >
              {p.name?.charAt(0)?.toUpperCase() || "?"}
            </span>
            <span className={`truncate font-semibold flex-1 ${p.isYou ? "text-[#FFD700]" : "text-[#d8fbff]"}`}>
              {p.name}
              {p.isYou ? " (You)" : ""}
            </span>
            <span className={`font-bold tabular-nums shrink-0 ${s.cls}`}>
              {s.icon} {s.label}
            </span>
          </div>
        );
      })}

      {/* Wait list */}
      {waitingPlayers.length > 0 && (
        <>
          <div className="mt-2 h-px bg-[#ff4fd8]/20" />
          <h3 className="text-xs uppercase tracking-wider text-[#ff4fd8]/70 text-center">
            <IconClock size={13} className="mb-0.5 mr-1.5 inline" /> Wait List • {waitingPlayers.length}
          </h3>
          {waitingPlayers.map((p) => (
            <div
              key={p.userId ?? p.name}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs bg-yellow-500/5 border border-yellow-500/20"
            >
              <span className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-black border shrink-0 bg-[#020617] border-yellow-500/30 text-yellow-400">
                {p.name?.charAt(0)?.toUpperCase() || "?"}
              </span>
              <span className={`truncate font-semibold flex-1 ${p.isYou ? "text-[#FFD700]" : "text-[#d8fbff]"}`}>
                {p.name}
                {p.isYou ? " (You)" : ""}
              </span>
              <IconClock size={14} className="shrink-0 text-yellow-400" />
            </div>
          ))}
          {waitingPlayers.some((p) => p.isYou) && (
            <button
              onClick={onExitToLobby}
              className="mt-1 w-full px-3 py-1.5 rounded-lg text-xs font-bold border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all"
            >
              <IconHome size={14} className="mr-1.5" /> Back to Lobby
            </button>
          )}
        </>
      )}
    </div>
  );
}
