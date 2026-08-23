"use client";
import React, { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import NavigationBar from "../../../../../components/navigation-bar";
import ArenaTable from "../../../../../components/crash-arena/ArenaTable";
import CrashEngine from "../../../../../components/games/crash-engine/CrashEngine";
import useCrashArenaRound from "../../../../../components/crash-arena/useCrashArenaRound";
import { useSocket } from "../../../../../context/SocketProvider";
import ReportModal from "../../../../../components/ReportModal";
import { IconPlug } from "@tabler/icons-react";
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
  const { socket } = useSocket();

  // ── Socket connection state (drives the "Reconnecting…" banner) ───
  // The realtime server holds the player's seat during its disconnect
  // grace window, so a dropped socket is worth surfacing — especially
  // to a seated player who could otherwise think they lost their seat.
  // Lazy-initialize from socket.connected so client-side navigation
  // (socket already live) doesn't flash the banner for one frame.
  const [socketConnected, setSocketConnected] = useState(
    () => Boolean(socket?.connected),
  );
  useEffect(() => {
    if (!socket) {
      setSocketConnected(false);
      return;
    }
    const onConnect = () => setSocketConnected(true);
    const onDisconnect = () => setSocketConnected(false);
    setSocketConnected(socket.connected);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, [socket]);

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
        // Clerk identity for reporting (userId is the internal users.id).
        clerkId: p.clerkId ?? null,
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
        clerkId: p.clerkId ?? null,
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

  // ── Report an opponent ───────────────────────────────────────────────
  // The seated roster carries each player's Clerk identity as `clerkId`
  // (the `userId` field is the internal users.id — never a public
  // identity), so a seated player can flag any opponent directly from
  // the seat grid. Players without a resolved clerkId (legacy rows)
  // simply can't be reported.
  const [reportTarget, setReportTarget] = useState(null);
  const handleReportPlayer = useCallback((player) => {
    if (!player?.clerkId || player.isYou) return;
    setReportTarget({ userId: player.clerkId, name: player.name || "Player" });
  }, []);

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
    // Only navigate away once the server has actually released the seat
    // (refund + status "left") — otherwise the lobby would keep showing
    // the player seated at the table and rejoining would fail with
    // "Already seated".
    const ok = await exitTable();
    if (ok) router.push("/casino/crash-arena");
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
        {/* Socket reconnecting banner — the realtime server holds the
            seat during its disconnect grace window, so reassure the
            player rather than leaving them guessing. */}
        {socket && !socketConnected && (
          <div className="mb-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-xl border border-amber-400/40 bg-amber-500/10 px-4 py-2.5 text-sm font-semibold text-amber-300">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-400" />
            </span>
            <span className="inline-flex items-center gap-1.5"><IconPlug size={14} /> Reconnecting…</span>
            {table?.amISeated && (
              <span className="font-normal text-amber-200/80">
                Your seat may be held for a short time. Don't close the tab.
              </span>
            )}
          </div>
        )}

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
          onReportPlayer={handleReportPlayer}
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

      {/* Report modal — flags a seated opponent for moderation. */}
      <ReportModal
        isOpen={!!reportTarget}
        onClose={() => setReportTarget(null)}
        onSubmit={async (reason, details) => {
          const res = await fetch("/api/reports/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reportedClerkId: reportTarget?.userId,
              gameType: "crash-arena",
              gameId: tableId ? String(tableId) : undefined,
              reason,
              details: details || undefined,
            }),
          });
          const data = await res.json();
          if (!data.success) throw new Error(data.error || "Failed to submit report");
        }}
        reportedPlayerName={reportTarget?.name || "Player"}
        gameType="Crash Arena"
      />
    </div>
  );
}
