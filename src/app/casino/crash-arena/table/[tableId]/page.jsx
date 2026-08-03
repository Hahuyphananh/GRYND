"use client";
import React, { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import NavigationBar from "../../../../components/navigation-bar";
import ArenaTable from "../../../../components/crash-arena/ArenaTable";
import CrashEngine from "../../../../components/games/crash-engine/CrashEngine";
import useCrashArenaRound from "../../../../components/crash-arena/useCrashArenaRound";
import Link from "next/link";

/**
 * Crash Arena Table Room — /casino/crash-arena/table/[tableId]
 *
 * Fetches table metadata from the API, then uses useCrashArenaRound
 * to drive the round lifecycle with real backend calls.
 * Mounts CrashEngine for the gameplay display.
 */
export default function TableRoomPage() {
  const params = useParams();
  const rawId = typeof params.tableId === "string" ? Number(params.tableId) : NaN;
  const tableId = Number.isFinite(rawId) ? rawId : null;
  const { isSignedIn } = useUser();
  const playerName = "You";

  // ── Fetch table metadata from API ─────────────────────────────────────
  const [table, setTable] = useState(null);
  const [tableLoading, setTableLoading] = useState(true);

  useEffect(() => {
    if (!tableId) return;
    setTableLoading(true);
    fetch("/api/crash-arena/tables", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (data?.success) {
          const found = data.data.find((t) => t.id === tableId);
          if (found) setTable(found);
        }
      })
      .catch(() => {})
      .finally(() => setTableLoading(false));
  }, [tableId]);

  // ── Round system hook (API-driven) ────────────────────────────────────
  const {
    roundState,
    crashEngineRef,
    crashEngineProps,
    startNewRound,
    goToNextRound,
    togglePlayerSitOut,
    joinTable,
    leaveTable,
    buyChips,
    busy,
    error: roundError,
  } = useCrashArenaRound({
    tableId,
    wager: table?.wager || 10,
    roundNumber: 1,
  });

  // ── Player actions ───────────────────────────────────────────────────

  const handleJoin = useCallback((buyIn) => {
    joinTable(buyIn);
  }, [joinTable]);

  const handleBuyChips = useCallback((amount) => {
    buyChips(playerName, amount);
  }, [buyChips, playerName]);

  const handleToggleSitOut = useCallback(() => {
    togglePlayerSitOut(playerName);
  }, [togglePlayerSitOut, playerName]);

  // ── Render ───────────────────────────────────────────────────────────

  if (tableLoading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-[#001933] to-[#000d1a] text-white px-4">
        <NavigationBar currentPath="/casino" />
        <span className="inline-block w-10 h-10 border-3 border-[#00e5ff] border-t-transparent rounded-full animate-spin mt-8" />
      </div>
    );
  }

  if (!table) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-[#001933] to-[#000d1a] text-white px-4">
        <NavigationBar currentPath="/casino" />
        <p className="text-2xl font-bold text-[#f5ff3b] mb-4">Table not found</p>
        <Link
          href="/casino/crash-arena"
          className="px-6 py-3 rounded-xl bg-[#00e5ff]/20 border border-[#00e5ff]/40 text-[#00e5ff] font-bold hover:bg-[#00e5ff]/30 transition-all"
        >
          ← Back to Lobby
        </Link>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-4 md:pb-8">
      <NavigationBar currentPath="/casino" />

      <div className="mt-4 w-full max-w-7xl lg:mt-8">
        {/* API error banner */}
        {roundError && (
          <div className="mb-3 px-4 py-2 rounded-lg bg-red-900/30 border border-red-400/40 text-red-300 text-sm text-center">
            {roundError}
          </div>
        )}

        <ArenaTable
          table={table}
          roundState={roundState}
          crashEngineRef={crashEngineRef}
          playerName={playerName}
          onStartRound={startNewRound}
          onNextRound={goToNextRound}
          onToggleSitOut={handleToggleSitOut}
          onJoin={handleJoin}
          onLeave={leaveTable}
          onBuyChips={handleBuyChips}
          busy={busy}
        >
          {/* CrashEngine renders in the game area */}
          <CrashEngine
            ref={crashEngineRef}
            crashPoint={crashEngineProps.crashPoint}
            running={crashEngineProps.running}
            onCashout={crashEngineProps.onCashout}
            onCrash={crashEngineProps.onCrash}
            onMultiplierUpdate={crashEngineProps.onMultiplierUpdate}
          />
        </ArenaTable>
      </div>
    </div>
  );
}
