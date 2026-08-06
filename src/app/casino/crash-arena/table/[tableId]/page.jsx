"use client";
import React, { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import NavigationBar from "../../../../../components/navigation-bar";
import ArenaTable from "../../../../../components/crash-arena/ArenaTable";
import CrashEngine from "../../../../../components/games/crash-engine/CrashEngine";
import useCrashArenaRound from "../../../../../components/crash-arena/useCrashArenaRound";
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
  const router = useRouter();
  const rawId = typeof params.tableId === "string" ? Number(params.tableId) : NaN;
  const tableId = Number.isFinite(rawId) ? rawId : null;
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
  // refetchTables is defined below but the hook needs its latest version
  // for socket-triggered refreshes — route through a ref to avoid the
  // circular reference (hook → refetchTables → hook functions).
  const refetchTablesRef = useRef(null);

  const {
    roundState,
    crashEngineRef,
    crashEngineProps,
    readyVotes,
    markReady,
    startNewRound,
    goToNextRound,
    syncPlayers,
    syncWaitingPlayers,
    syncRoundFromServer,
    joinTable,
    leaveTable,
    exitTable,
    buyChips,
    busy,
    error: roundError,
  } = useCrashArenaRound({
    tableId,
    wager: table?.wager || 10,
    roundNumber: 1,
    // Socket-triggered table updates re-fetch the roster + latest round
    // so round state stays in sync across all players at the table.
    onRoomUpdate: () => refetchTablesRef.current?.(),
  });

  // Map the server's seated roster to the room's local player format.
  // The caller's own seat is rendered as "You" so existing room logic works.
  // userId is kept on the object for future disambiguation (display names
  // are not guaranteed unique).
  const mapServerPlayers = useCallback(
    (tbl) =>
      (tbl?.players || []).map((p) => ({
        userId: p.userId,
        name: p.isYou ? playerName : p.name,
        balance: p.balance,
        isYou: p.isYou,
      })),
    [playerName],
  );

  // Wait-listed players (joined mid-round or stepped off via Leave).
  const mapWaitingPlayers = useCallback(
    (tbl) =>
      (tbl?.waitingPlayers || []).map((p) => ({
        userId: p.userId,
        name: p.isYou ? playerName : p.name,
        balance: p.balance,
        isYou: p.isYou,
      })),
    [playerName],
  );

  // Single source of truth for refreshing table state: roster (seated +
  // waiting) + the latest round (so a round started by another player
  // syncs here).
  const refetchTables = useCallback(async () => {
    if (!tableId || busy) return;
    try {
      const res = await fetch("/api/crash-arena/tables", { cache: "no-store" });
      const data = await res.json();
      if (!data?.success) return;
      const found = data.data.find((t) => t.id === tableId);
      if (found) {
        syncPlayers(mapServerPlayers(found));
        syncWaitingPlayers(mapWaitingPlayers(found));
        if (found.latestRound) syncRoundFromServer(found.latestRound);
      }
    } catch {
      // silent — keep the current state
    }
  }, [tableId, busy, mapServerPlayers, mapWaitingPlayers, syncPlayers, syncWaitingPlayers, syncRoundFromServer]);

  // Expose the latest refetchTables to the hook's socket callback.
  refetchTablesRef.current = refetchTables;

  // Show every seated + waiting player from the server — covers lobby
  // joins, reloads, and any players who were already at the table.
  useEffect(() => {
    if (!table) return;
    syncPlayers(mapServerPlayers(table));
    syncWaitingPlayers(mapWaitingPlayers(table));
    if (table.latestRound) syncRoundFromServer(table.latestRound);
  }, [table, mapServerPlayers, mapWaitingPlayers, syncPlayers, syncWaitingPlayers, syncRoundFromServer]);

  // Keep the roster fresh so players who join/leave/wait show up.
  // Skips syncing while a join/leave API call is in flight to avoid a
  // flicker from mid-transaction server state.
  useEffect(() => {
    if (!tableId) return;
    const interval = setInterval(refetchTables, 5000);
    return () => clearInterval(interval);
  }, [tableId, refetchTables]);

  // ── Player actions ───────────────────────────────────────────────────

  const handleJoin = useCallback((buyIn) => {
    joinTable(buyIn);
  }, [joinTable]);

  const handleBuyChips = useCallback((amount) => {
    buyChips(playerName, amount);
  }, [buyChips, playerName]);

  const handleLeave = useCallback(() => {
    leaveTable();
  }, [leaveTable]);

  const handleExitToLobby = useCallback(async () => {
    await exitTable();
    router.push("/casino/crash-arena");
  }, [exitTable, router]);

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
          readyVotes={readyVotes}
          markReady={markReady}
          playerName={playerName}
          onStartRound={startNewRound}
          onNextRound={goToNextRound}
          onJoin={handleJoin}
          onLeave={handleLeave}
          onExitToLobby={handleExitToLobby}
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
