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
    <div className="flex flex-col overflow-hidden rounded-2xl border border-[#00e5ff]/35 bg-[#040d24] transition-all duration-300 hover:border-[#00e5ff]/60 hover:shadow-[0_0_30px_rgba(0,229,255,0.25)]">
      {/* ═══ Table amount card ═══ */}
      <div className="relative p-5 flex flex-col gap-3">
        {/* Top accent line */}
        <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent opacity-70" />

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
          <span
            className={`px-3 py-1 rounded-full text-xs font-bold border
              ${openCount > 0
                ? "bg-[#00e5ff]/15 text-[#00e5ff] border-[#00e5ff]/40"
                : "bg-gray-500/15 text-gray-400 border-gray-500/30"}`}
          >
            {tables.length === 0 ? "NO GAMES" : openCount > 0 ? `${openCount} OPEN` : "FULL"}
          </span>
        </div>

        {/* Table name */}
        <div className="text-sm font-bold text-[#d8fbff]">${wager} Crash Arena</div>

        {/* Stats row */}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex flex-col">
            <span className="text-[#9dd8ff]/60 text-xs">Min Buy-in</span>
            <span className="text-[#d8fbff] font-semibold">${minBuyIn}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-[#9dd8ff]/60 text-xs">Seated</span>
            <span className="text-[#d8fbff] font-semibold">
              {tables.length === 0
                ? "—"
                : `${totalPlayers}/${maxPlayers * tables.length}`}
            </span>
          </div>
        </div>

        {/* Create Table button */}
        <button
          onClick={() => onCreate?.(wager)}
          disabled={isCreating}
          className={`mt-1 w-full py-2.5 rounded-xl font-bold text-sm text-center transition-all duration-300
            bg-gradient-to-r from-[#00e5ff]/20 to-[#007cf0]/20 text-[#00e5ff] border border-[#00e5ff]/30
            hover:from-[#00e5ff]/35 hover:to-[#007cf0]/35 hover:scale-[1.02] hover:shadow-[0_0_20px_rgba(0,229,255,0.4)]
            disabled:opacity-60 disabled:hover:scale-100`}
        >
          {isCreating ? "Creating…" : "＋ Create Table"}
        </button>
      </div>

      {/* ═══ Available Games section ═══ */}
      <div className="border-t border-[#00e5ff]/20 bg-[#020a1c]/60 p-4 flex flex-col gap-2 flex-1">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-bold uppercase tracking-widest text-[#9dd8ff]">
            Available Games
          </h3>
          <span className="text-xs text-[#9dd8ff]/50">
            {tables.length} table{tables.length === 1 ? "" : "s"}
          </span>
        </div>

        {tables.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#00e5ff]/20 bg-[#040d24]/40 px-3 py-4 text-center">
            <p className="text-sm text-[#9dd8ff]/70">
              No open games right now.
            </p>
            <p className="text-xs text-[#9dd8ff]/40 mt-1">
              Be the first — create a ${wager} table above!
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
                      : "border-[#00e5ff]/20 bg-[#08142f]/80 hover:border-[#00e5ff]/45"}`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-bold text-[#d8fbff] truncate">
                        Table #{t.id}
                      </span>
                      {isLive && (
                        <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-[#00ffa6]/15 text-[#00ffa6] border border-[#00ffa6]/40 animate-pulse">
                          LIVE
                        </span>
                      )}
                      {isFull && (
                        <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-gray-500/15 text-gray-400 border border-gray-500/30">
                          FULL
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[#9dd8ff]/70 truncate">
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
                        : "bg-[#00e5ff] text-[#001933] hover:bg-[#49eeff] hover:shadow-[0_0_12px_rgba(0,229,255,0.5)] disabled:bg-[#246874] disabled:cursor-wait"}`}
                  >
                    {isBusy ? "Joining…" : isFull ? "Full" : "Join"}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {!isSignedIn && (
          <p className="text-[11px] text-[#FFD700]/70 mt-auto text-center">
            Sign in to create or join a table.
          </p>
        )}
      </div>
    </div>
  );
}
