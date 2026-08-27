"use client";
import React from "react";

/**
 * TableList — flat list of all available Crash Arena tables.
 *
 * Each table shows its wager, host, pot, player count, and a Join button.
 * No longer grouped by wager — players create tables with custom wagers.
 *
 * Props:
 *   tables       — all lobby tables (non-AI, non-closed)
 *   isSignedIn   — whether the user is authenticated
 *   busyTableId  — table id with an in-flight join (or null)
 *   onJoin       — (table) => void — open buy-in flow for a table
 */
export default function TableList({
  tables = [],
  isSignedIn = false,
  busyTableId = null,
  onJoin,
}) {
  return (
    <div className="rounded-2xl border border-amber-700/60 bg-black/40 overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-amber-700/40 bg-black/30 flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-widest text-cyan-300">
          Available Games
        </h3>
        <span className="text-xs text-cyan-100/50">
          {tables.length} table{tables.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Table list */}
      <div className="p-4 flex flex-col gap-2">
        {tables.length === 0 ? (
          <div className="rounded-xl border border-dashed border-amber-700/40 bg-black/30 px-3 py-4 text-center">
            <p className="text-sm text-white/60">
              No open games right now.
            </p>
            <p className="text-xs text-white/40 mt-1">
              Create a table above to get started!
            </p>
          </div>
        ) : (
          tables.map((t) => {
            const isLive = t.roundStatus === "running";
            const isFull = t.playerCount >= t.maxPlayers;
            const isBusy = busyTableId === t.id;
            return (
              <div
                key={t.id}
                className={`flex items-center justify-between gap-3 rounded-xl border p-3 transition-colors
                  ${isFull
                    ? "border-gray-500/20 bg-[#0a0a14]/60 opacity-75"
                    : "border-cyan-700/30 bg-slate-900/80 hover:border-cyan-500/50"}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-white/90 truncate">
                      {t.name || `Table #${t.id}`}
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
                  <p className="text-xs text-cyan-100/60 truncate mt-0.5">
                    {t.hostName ? `Host: ${t.hostName} · ` : ""}
                    Big Blind <span className="text-amber-300 font-bold">${t.wager}</span>
                    {t.smallBlind != null
                      ? ` · Small Blind $${t.smallBlind}`
                      : ""}{" "}
                    · Pot ${(t.pot || 0).toLocaleString()} ·{" "}
                    {t.playerCount}/{t.maxPlayers} players
                  </p>
                </div>
                <button
                  onClick={() => onJoin?.(t)}
                  disabled={isFull || isBusy || !isSignedIn}
                  className={`shrink-0 px-4 py-1.5 rounded-lg text-sm font-bold transition-all duration-200
                    ${isFull
                      ? "bg-gray-700/30 text-gray-500 cursor-not-allowed"
                      : "bg-cyan-500 text-black hover:bg-cyan-400 hover:shadow-[0_0_12px_rgba(34,211,238,0.5)] disabled:bg-cyan-500/30 disabled:cursor-wait"}`}
                >
                  {isBusy ? "Joining…" : isFull ? "Full" : "Join"}
                </button>
              </div>
            );
          })
        )}

        {!isSignedIn && tables.length > 0 && (
          <p className="text-[11px] text-amber-200/70 text-center mt-1">
            Sign in to join a table.
          </p>
        )}
      </div>
    </div>
  );
}
