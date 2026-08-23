"use client";
import React from "react";
import { CRASH_MIN_BUYIN_MULTIPLIER } from "../../lib/games/crash/constants";

/**
 * WagerSection — one table amount in the Crash Arena lobby.
 *
 * Renders a "table amount" card (wager, min buy-in, capacity) with a
 * prominent Create Table button, and directly below it an "Available
 * Games" section listing every table of that wager with a Join button —
 * grouped per wager, like other multiplayer lobbies.
 *
 * Props:
 *   wager        — round wager amount for this section (e.g. 5)
 *   tables       — all lobby tables that share this wager
 *   isSignedIn   — whether the user is authenticated
 *   creating     — wager currently being created (or null)
 *   busyTableId  — table id with an in-flight join (or null)
 *   onCreate     — (wager) => void  — create a brand-new table
 *   onJoin       — (table) => void  — open buy-in flow for a table
 */
export default function WagerSection({
  wager,
  tables = [],
  isSignedIn = false,
  creating = null,
  busyTableId = null,
  onCreate,
  onJoin,
}) {
  const minBuyIn = wager * CRASH_MIN_BUYIN_MULTIPLIER;
  const maxPlayers = 6;
  const openCount = tables.filter((t) => t.playerCount < t.maxPlayers).length;
  const totalPlayers = tables.reduce((sum, t) => sum + (t.playerCount || 0), 0);
  const isCreating = creating === wager;

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-amber-700/60 bg-black/40 transition-all duration-300 hover:border-amber-500/60 hover:shadow-[0_0_30px_rgba(251,191,36,0.2)]">
      {/* ═══ Table amount card ═══ */}
      <div className="relative p-5 flex flex-col gap-3">
        {/* Top accent line */}
        <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-amber-400 to-transparent opacity-70" />

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs uppercase tracking-widest text-cyan-100/60">
              Round Wager
            </span>
            <div className="text-2xl font-black text-amber-300 drop-shadow-[0_0_8px_rgba(251,191,36,0.4)]">
              ${wager}
            </div>
          </div>
          <span
            className={`px-3 py-1 rounded-full text-xs font-bold border
              ${openCount > 0
                ? "bg-cyan-500/15 text-cyan-300 border-cyan-500/40"
                : "bg-gray-500/15 text-gray-400 border-gray-500/30"}`}
          >
            {tables.length === 0 ? "NO GAMES" : openCount > 0 ? `${openCount} OPEN` : "FULL"}
          </span>
        </div>

        {/* Table name */}
        <div className="text-sm font-bold text-white/90">${wager} Crash Arena</div>

        {/* Stats row */}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex flex-col">
            <span className="text-cyan-100/50 text-xs">Min Buy-in</span>
            <span className="text-white/90 font-semibold">${minBuyIn}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-cyan-100/50 text-xs">Seated</span>
            <span className="text-white/90 font-semibold">
              {tables.length === 0
                ? "-"
                : `${totalPlayers}/${maxPlayers * tables.length}`}
            </span>
          </div>
        </div>

        {/* Create Table button */}
        <button
          onClick={() => onCreate?.(wager)}
          disabled={isCreating}
          className={`mt-1 w-full py-2.5 rounded-xl font-bold text-sm text-center transition-all duration-300
            bg-amber-500 text-black border-b-4 border-amber-700
            hover:brightness-110 hover:scale-[1.02] hover:shadow-[0_0_20px_rgba(251,191,36,0.4)]
            disabled:opacity-60 disabled:hover:scale-100`}
        >
          {isCreating ? "Creating…" : "＋ Create Table"}
        </button>
      </div>

      {/* ═══ Available Games section ═══ */}
      <div className="border-t border-amber-700/40 bg-black/30 p-4 flex flex-col gap-2 flex-1">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-widest text-cyan-300">
            Available Games
          </h3>
          <span className="text-xs text-cyan-100/50">
            {tables.length} table{tables.length === 1 ? "" : "s"}
          </span>
        </div>

        {tables.length === 0 ? (
          <div className="rounded-xl border border-dashed border-amber-700/40 bg-black/30 px-3 py-4 text-center">
            <p className="text-sm text-white/60">
              No open games right now.
            </p>
            <p className="text-xs text-white/40 mt-1">
              Be the first. Create a ${wager} table above!
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {tables.map((t) => {
              const isLive = t.roundStatus === "running";
              const isFull = t.playerCount >= t.maxPlayers;
              const isBusy = busyTableId === t.id;
              return (
                <div
                  key={t.id}
                  className={`flex items-center justify-between gap-2 rounded-xl border p-2.5 transition-colors
                    ${isFull
                      ? "border-gray-500/20 bg-[#0a0a14]/60 opacity-75"
                      : "border-cyan-700/30 bg-slate-900/80 hover:border-cyan-500/50"}`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-bold text-white/90 truncate">
                        Table #{t.id}
                      </span>
                      {isLive && (
                        <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 animate-pulse">
                          LIVE
                        </span>
                      )}
                      {isFull && (
                        <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-gray-500/15 text-gray-400 border border-gray-500/30">
                          FULL
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-cyan-100/60 truncate">
                      {t.hostName ? `Host: ${t.hostName} · ` : ""}
                      Pot ${(t.pot || 0).toLocaleString()} ·{" "}
                      {t.playerCount}/{t.maxPlayers} players
                    </p>
                  </div>
                  <button
                    onClick={() => onJoin?.(t)}
                    disabled={isFull || isBusy}
                    className={`shrink-0 px-4 py-1.5 rounded-lg text-sm font-bold transition-all duration-200
                      ${isFull
                        ? "bg-gray-700/30 text-gray-500 cursor-not-allowed"
                        : "bg-cyan-500 text-black hover:bg-cyan-400 hover:shadow-[0_0_12px_rgba(34,211,238,0.5)] disabled:bg-cyan-500/30 disabled:cursor-wait"}`}
                  >
                    {isBusy ? "Joining…" : isFull ? "Full" : "Join"}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {!isSignedIn && (
          <p className="text-[11px] text-amber-200/70 mt-auto text-center">
            Sign in to create or join a table.
          </p>
        )}
      </div>
    </div>
  );
}
