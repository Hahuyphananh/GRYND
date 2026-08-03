"use client";
import React from "react";
import TableList from "./TableList";

/**
 * ArenaLobby — the main lobby where players browse tables.
 * Tables link to /casino/crash-arena/table/[id] via TableCard.
 *
 * Props:
 *   tables      — array of table objects from API
 *   userBalance — player's wallet balance (null = loading)
 *   loading     — whether data is still loading
 */
export default function ArenaLobby({ tables = [], userBalance = null, loading = false }) {
  return (
    <div className="relative w-full">
      {/* Header */}
      <div className="mb-6 text-center">
        <h1 className="text-3xl font-extrabold tracking-tight text-[#f5ff3b] sm:text-4xl">
          🚀 Crash Arena
        </h1>
        <p className="mt-2 text-sm text-[#9dd8ff] opacity-80">
          Join a table, survive the crash, claim the pot.
        </p>
      </div>

      {/* Balance bar */}
      <div className="mb-6 flex items-center justify-center gap-3 px-4 py-3 rounded-2xl border border-[#00e5ff]/25 bg-[#040d24]/60 backdrop-blur-sm max-w-sm mx-auto">
        <span className="text-[#9dd8ff]/60 text-sm">Your Balance</span>
        <span className="text-xl font-black text-[#00e5ff] drop-shadow-[0_0_10px_rgba(0,229,255,0.5)]">
          {loading && userBalance === null
            ? "..."
            : `$${(userBalance ?? 0).toLocaleString()}`}
        </span>
      </div>

      {/* Table grid */}
      {loading && tables.length === 0 ? (
        <div className="flex items-center justify-center py-16">
          <span className="inline-block w-10 h-10 border-3 border-[#00e5ff] border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <TableList tables={tables} />
      )}
    </div>
  );
}
