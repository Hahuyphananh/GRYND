"use client";
import React from "react";
import { IconBomb, IconCircleCheck, IconFlag, IconRocket } from "@tabler/icons-react";
import IconAvatar from "../IconAvatar";
import { frameWrapperProps } from "../FrameAvatar";


/**
 * PlayerList — shows seated players at an arena table with live round status.
 *
 * Props:
 *   players  — array of { name, iconKey, balance, isYou?, isSittingOut?,
 *                        allIn?, folded?, foldedAtMultiplier?, busted?, isPlaying? }
 *   maxSeats — total seats at the table
 *   phase    — current round phase ("waiting" | "running" | "crashed" | "settling")
 *   readyUserIds — ids of seated players who pressed Start Round (the ready
 *                  vote). AI bots never vote, so they are simply absent.
 *   onReport — (player) => void — opens the report modal for a seated opponent
 *   onRemoveAi — (player) => void — the HOST's control to remove an AI
 *              seat (only rendered on bot cards when provided)
 *   onRenameAi — (player) => void — the HOST's control to rename an AI
 *              seat (only rendered on bot cards when provided)
 */
export default function PlayerList({ players = [], maxSeats = 6, phase = "waiting", readyUserIds = [], onReport, onRemoveAi, onRenameAi }) {
  const seats = Array.from({ length: maxSeats }, (_, i) => players[i] || null);
  const isLive = phase === "running" || phase === "crashed" || phase === "settling";

  /**
   * A seated player who has cast their ready vote (never a bot — bots don't
   * vote). Only in the waiting phase, and never alongside SITTING OUT, so a
   * seat shows one readiness state at a time (the sidebar resolves it the
   * same way).
   */
  const isReady = (player) =>
    !isLive &&
    !player?.isSittingOut &&
    player?.userId != null &&
    readyUserIds.includes(player.userId);

  /**
   * Border + glow treatment for a player card.
   *
   * Emphasis ladder, strongest first: active (in the hand) → all-in/folded/
   * busted (distinct status colours) → waiting → sitting out → empty seat.
   * The active card used to carry a permanent `animate-pulse`; the curve is the
   * focus of the round and an endlessly blinking seat competed with it, so the
   * "in the hand" read is now a steadier treatment: a brighter cyan ring than a
   * merely seated player, plus the In-flight badge.
   */
  function cardStyle(player) {
    if (!player) return "border-dashed border-[#00e5ff]/10 bg-transparent opacity-40";
    if (player.isSittingOut) return "border-yellow-500/30 bg-[#020617] opacity-60";
    if (player.allIn) return "border-[#ff4fd8]/50 bg-[#ff4fd8]/10 shadow-[0_0_12px_rgba(255,79,216,0.25)]";
    if (player.folded) return "border-yellow-500/40 bg-yellow-950/20 opacity-70 shadow-[0_0_12px_rgba(250,204,21,0.15)]";
    if (player.busted) return "border-red-500/40 bg-red-950/30 shadow-[0_0_12px_rgba(239,68,68,0.25)]";
    if (player.isPlaying && isLive) return "border-[#00e5ff]/60 bg-[#020617] shadow-[0_0_16px_rgba(0,229,255,0.32)]";
    return "border-[#00e5ff]/30 bg-[#020617] shadow-[0_0_12px_rgba(0,229,255,0.1)]";
  }

  return (
    <div className="flex flex-wrap gap-2 justify-center">
      {seats.map((player, i) => {
        // Determine the live-status badge
        let liveBadge = null;
        if (player && isLive && !player.isSittingOut) {
          // Every badge is keyed by the state it represents and carries the
          // shared one-shot entrance. The key is what makes the animation
          // exact: a real state change (active → folded) swaps the key, so
          // React mounts a fresh span and the entrance plays once; a poll or
          // socket snapshot carrying the SAME state re-renders the same key,
          // the span is reused and nothing replays. All-in stays deliberately
          // pink and folded yellow: two states must never read as one.
          if (player.allIn) {
            liveBadge = (
              <span key="allin" className="animate-state-in text-[10px] px-1.5 py-0.5 rounded-full bg-[#ff4fd8]/15 text-[#ff4fd8] border border-[#ff4fd8]/40 font-bold">
                <IconCircleCheck size={12} className="mr-1 inline" /> All-in
              </span>
            );
          } else if (player.folded) {
            liveBadge = (
              <span key="folded" className="animate-state-in text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 border border-yellow-500/30 font-bold">
                <IconFlag size={12} className="mr-1 inline" />
                {player.foldedAtMultiplier != null
                  ? `Folded @${player.foldedAtMultiplier.toFixed(2)}x`
                  : "Folded"}
              </span>
            );
          } else if (player.busted) {
            liveBadge = (
              <span key="busted" className="animate-state-in text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/30 font-bold">
                <IconBomb size={12} className="mr-1 inline" /> Busted
              </span>
            );
          } else if (player.isPlaying) {
            liveBadge = (
              <span key="inflight" className="animate-state-in text-[10px] px-1.5 py-0.5 rounded-full bg-[#00e5ff]/15 text-[#00e5ff] border border-[#00e5ff]/30 font-bold">
                <IconRocket size={12} className="mr-1 inline" /> In flight…
              </span>
            );
          }
        }

        return (
          <div
            key={i}
            className={`flex flex-col items-center gap-1 p-2 rounded-xl border min-w-[85px] transition-all duration-300 ${cardStyle(player)}`}
          >
            {/* Avatar — official Grynd icon, wrapped in the seat's
                status-colored ring. Empty seats show their number. */}
            <div
              className={`relative w-10 h-10 rounded-full overflow-hidden border-2
                ${player
                  ? player.isYou
                    ? "border-[#FFD700] ring-2 ring-[#FFD700]/40"
                    : player.busted
                      ? "border-red-500/50"
                      : "border-[#00e5ff]/40"
                  : "border-gray-500/20 bg-transparent text-gray-500"
                } ${frameWrapperProps(player?.profileFrame).className}`}
              style={frameWrapperProps(player?.profileFrame).style}
            >
              {player ? (
                <IconAvatar
                  iconKey={player.iconKey}
                  name={player.name}
                  size="h-full w-full"
                  showFrame={false}
                />
              ) : (
                <span className="flex h-full w-full items-center justify-center text-sm font-bold">
                  {i + 1}
                </span>
              )}
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

            {/* Difficulty badge (AI bots only) — easy / medium / hard
                drives the bot's fold target, so it's surfaced right on
                the seat card. */}
            {player?.isBot && player.aiDifficulty && (
              <span
                className={`px-1.5 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider border ${
                  player.aiDifficulty === "easy"
                    ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-300"
                    : player.aiDifficulty === "hard"
                      ? "border-red-400/40 bg-red-500/15 text-red-300"
                      : "border-amber-400/40 bg-amber-500/15 text-amber-300"
                }`}
              >
                {player.aiDifficulty}
              </span>
            )}

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

            {/* Ready badge — waiting phase only: this seat has already voted
                to start the next hand. Static (no idle animation). */}
            {isReady(player) && (
              <span className="animate-state-in text-[10px] px-1.5 py-0.5 rounded-full bg-[#00e5ff]/15 text-[#00e5ff] border border-[#00e5ff]/30 font-bold">
                <IconCircleCheck size={12} className="mr-1 inline" /> READY
              </span>
            )}

            {/* Live round badge (folded / busted / in-flight) */}
            {liveBadge}

            {/* Host controls for AI seats — rename + remove. Only rendered
                on bot cards and only when the parent (the private-table
                host) passes the handlers. */}
            {player?.isBot && (onRenameAi || onRemoveAi) && (
              <div className="mt-0.5 flex items-center gap-1">
                {onRenameAi && (
                  <button
                    onClick={() => onRenameAi(player)}
                    title={`Rename ${player.name || "this AI"}`}
                    aria-label={`Rename ${player.name || "this AI"}`}
                    className="px-1.5 py-0.5 rounded-md border border-cyan-500/40 bg-cyan-500/15 text-[10px] font-bold text-cyan-300 transition-all hover:bg-cyan-500/30 hover:shadow-[0_0_8px_rgba(34,211,238,0.4)]"
                  >
                    ✎
                  </button>
                )}
                {onRemoveAi && (
                  <button
                    onClick={() => onRemoveAi(player)}
                    title={`Remove ${player.name || "this AI"} from the table`}
                    aria-label={`Remove ${player.name || "this AI"}`}
                    className="px-1.5 py-0.5 rounded-md border border-red-500/40 bg-red-500/15 text-[10px] font-bold text-red-400 transition-all hover:bg-red-500/30 hover:shadow-[0_0_8px_rgba(239,68,68,0.4)]"
                  >
                    ✕
                  </button>
                )}
              </div>
            )}

            {/* Report flag — lets a seated player report any opponent at
                the table. Hidden on the player's own seat and on empty
                seats; only wired up when the parent passes onReport. */}
            {player && !player.isYou && !player.isBot && onReport && (
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
