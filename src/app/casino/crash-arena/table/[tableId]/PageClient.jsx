"use client";
import React, { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import NavigationBar from "../../../../../components/navigation-bar";
import ArenaTable from "../../../../../components/crash-arena/ArenaTable";
import CrashEngine from "../../../../../components/games/crash-engine/CrashEngine";
import useCrashArenaRound from "../../../../../components/crash-arena/useCrashArenaRound";
import { useSocket } from "../../../../../context/SocketProvider";
import EmotePicker from "../../../../../components/game/EmotePicker";
import useGameEmotes from "../../../../../hooks/useGameEmotes";
import { useUser } from "@clerk/nextjs";
import ReportModal from "../../../../../components/ReportModal";
import { IconPlug } from "@tabler/icons-react";
// Shared Creator Mode foundation (admin-only): mounts the viewport
// recorder + overlay, auto-starts when a round actually begins running
// (real gameplay — the crash curve flies) and auto-stops after the crash
// result is captured. The table lobby, nav and modals stay outside the
// shared CreatorModeHost recording viewport so nothing is recorded until
// real gameplay starts.
import CreatorModeHost from "../../../../../components/creator-mode/CreatorModeHost";
import { CreatorResponsiveLayout } from "../../../../../components/creator-mode/CreatorModeLayout";
import DailyLossGuard from "../../../../../components/DailyLossGuard";
import SessionGuard from "../../../../../components/SessionGuard";
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
  const searchParams = useSearchParams();
  const { isSignedIn: isUserSignedIn, user } = useUser();
  // Invite code for private tables — travels in the shared URL (?code=)
  // so the join route can validate it. The host's code comes from their
  // own table row instead (returned only to the host by the tables API).
  const urlInviteCode =
    typeof searchParams?.get === "function"
      ? (searchParams.get("code") ?? null)
      : null;
  const rawId = typeof params.tableId === "string" ? Number(params.tableId) : NaN;
  const tableId = Number.isFinite(rawId) ? rawId : null;
  const playerName = "You";
  const { socket } = useSocket();
  // Emotes — dedicated per-table room (mirrors the other PvP games).
  const { incomingEmote, myEmote, sendEmote } = useGameEmotes({
    socket,
    roomId: tableId ? `crash:emote:${tableId}` : null,
    eventName: "crash-arena:emote",
    selfId: user?.id,
  });

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

  // ── User's wallet balance (used to cap the buy-in modal to the 10M
  //    hard limit when joining/buying chips at this table) ───────────────
  const [userBalance, setUserBalance] = useState(null);

  useEffect(() => {
    if (!isUserSignedIn) return;
    fetch("/api/get-user-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    })
      .then((r) => r.json())
      .then((data) => {
        if (data?.success) setUserBalance(Number(data.data.balance));
      })
      .catch(() => {});
  }, [isUserSignedIn]);

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
    submitAction,
    currentMultiplier,
    activeCheckpointIndex,
    checkpointMultiplierFor,
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
    // Free practice tables (human vs the GRYND AI bot) drive the bot's
    // cashout from the client — the hook watches the multiplier and
    // resolves the bot through /api/crash-arena/ai-cashout. The bot's
    // aggressiveness follows the difficulty picked in the lobby.
    isAi: table?.isAi || false,
    aiDifficulty: table?.aiDifficulty || "medium",
    // Private tables: only the host's client drives the AI seats (the
    // server rejects bot actions from non-hosts).
    isPrivate: table?.isPrivate || false,
    amIHost: table?.amIHost || false,
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
        // The reserved GRYND AI bot — never reportable.
        isBot: Boolean(p.isBot),
        // Per-bot difficulty (Add-AI dialog) — drives the bot's decisions.
        aiDifficulty: p.aiDifficulty ?? null,
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
        isBot: Boolean(p.isBot),
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
  // The per-table socket room (useCrashArenaRound) pushes round starts,
  // cashouts, ready votes and joined/left/settled updates instantly, so
  // this HTTP poll is a reconcile/safety net — 10s is plenty and halves
  // the previous 5s fan-out of the (wide) /tables response.
  useEffect(() => {
    if (!tableId) return;
    const interval = setInterval(refetchTables, 10000);
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
    // The GRYND AI bot has no Clerk account — nothing to report.
    if (!player?.clerkId || player.isYou || player.isBot) return;
    setReportTarget({ userId: player.clerkId, name: player.name || "Player" });
  }, []);

  // ── Player actions ───────────────────────────────────────────────────

  // Responsible-play guard (mirrors confirmLargeStake in PvpLobby): confirm
  // before a large buy-in (>= 10,000 tokens or > 10% of the wallet balance).
  const confirmLargeBuyIn = useCallback((buyIn) => {
    const amount = Number(buyIn);
    if (!Number.isFinite(amount) || amount <= 0) return true;
    const bal = Number(userBalance);
    const isLargeAbsolute = amount >= 10000;
    const isLargeVsBalance = Number.isFinite(bal) && bal > 0 && amount > bal * 0.1;
    if (!isLargeAbsolute && !isLargeVsBalance) return true;
    return window.confirm(
      `You're about to buy in for ${amount.toLocaleString()} tokens — that's ${
        isLargeVsBalance ? "more than 10% of your balance" : "a large amount"
      }. Continue?`,
    );
  }, [userBalance]);

  const handleJoin = useCallback((buyIn, joinCode) => {
    if (!confirmLargeBuyIn(buyIn)) return;
    joinTable(buyIn, joinCode);
  }, [joinTable, confirmLargeBuyIn]);

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

  // ── Add an AI seat (private tables, host only) ─────────────────────
  // The server validates host + isPrivate; the new bot shows up via the
  // roster refetch and the host's client drives its decisions through
  // /api/crash-arena/action with forBot + forBotUserId.
  const handleAddAi = useCallback(async (difficulty, stack, name) => {
    if (!tableId) return false;
    try {
      const res = await fetch("/api/crash-arena/add-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          tableId,
          difficulty,
          ...(stack != null && Number.isFinite(Number(stack)) ? { stack: Number(stack) } : {}),
          ...(name ? { name } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) return false;
      // Refresh the roster so the new bot seat shows up immediately.
      refetchTablesRef.current?.();
      return true;
    } catch {
      return false;
    }
  }, [tableId]);

  // ── Rename an AI seat (private tables, host only) ───────────────────
  // The custom name is stored on the seat (never the shared users row);
  // the roster refetch shows it everywhere immediately.
  const handleRenameAi = useCallback(async (botPlayer, newName) => {
    if (!tableId || !botPlayer?.userId || !newName) return false;
    try {
      const res = await fetch("/api/crash-arena/rename-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tableId, userId: botPlayer.userId, name: newName }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) return false;
      refetchTablesRef.current?.();
      return true;
    } catch {
      return false;
    }
  }, [tableId]);

  // ── Remove an AI seat (private tables, host only) ───────────────────
  // The server re-validates host + private and releases any mid-round
  // entry; the roster refetch makes the removed bot disappear instantly.
  const handleRemoveAi = useCallback(async (botPlayer) => {
    if (!tableId || !botPlayer?.userId) return false;
    try {
      const res = await fetch("/api/crash-arena/remove-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tableId, userId: botPlayer.userId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) return false;
      refetchTablesRef.current?.();
      return true;
    } catch {
      return false;
    }
  }, [tableId]);

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
    <DailyLossGuard>
      <SessionGuard />
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

        {/* Only the actual table round is recorded — the nav, socket
            banner, API banner, emotes widget and report modal stay
            outside. Recording auto-starts when the round begins running
            and stops once the crash result has been captured. */}
        <CreatorModeHost
          autoStart={roundState?.phase === "running"}
          autoStop={
            roundState?.phase === "crashed" ||
            roundState?.phase === "settling"
          }
          gameLabel="crash-arena"
        >
        <CreatorResponsiveLayout>
        <ArenaTable
          table={table}
          roundState={roundState}
          crashEngineRef={crashEngineRef}
          readyVotes={readyVotes}
          markReady={markReady}
          playerName={playerName}
          onStartRound={startNewRound}
          onNextRound={goToNextRound}
          onSubmitAction={submitAction}
          currentMultiplier={currentMultiplier}
          activeCheckpointIndex={activeCheckpointIndex}
          checkpointMultiplierFor={checkpointMultiplierFor}
          onJoin={handleJoin}
          // Private tables: the invite code from the shared URL, or the
          // host's own code (tables API returns it to the host only).
          inviteCode={urlInviteCode ?? (table?.amIHost ? table?.joinCode ?? null : null)}
          onLeave={handleLeave}
          onExitToLobby={handleExitToLobby}
          onBuyChips={handleBuyChips}
          onAddAi={handleAddAi}
          onRemoveAi={handleRemoveAi}
          onRenameAi={handleRenameAi}
          // Private tables are virtual chips — the buy-in is play money the
          // player chooses freely, so it's NOT capped by the wallet balance.
          maxBalance={table?.isPrivate ? null : userBalance}
          busy={busy}
          onReportPlayer={handleReportPlayer}
        >
          {/* CrashEngine renders in the game area. Crash Poker keeps the
              crash point server-only until the crash, so crashPoint is null:
              the curve flies blind and the hook triggers the explosion when
              the server announces the crash. startedAt aligns the curve to
              the server's hand start so everyone sees the same multiplier. */}
          <CrashEngine
            ref={crashEngineRef}
            crashPoint={crashEngineProps.crashPoint}
            startedAt={crashEngineProps.startedAt}
            running={crashEngineProps.running}
            curveFrom={crashEngineProps.curveFrom}
            curveResumedAt={crashEngineProps.curveResumedAt}
            curveCap={crashEngineProps.curveCap}
            onCashout={crashEngineProps.onCashout}
            onCrash={crashEngineProps.onCrash}
            onMultiplierUpdate={crashEngineProps.onMultiplierUpdate}
          />
        </ArenaTable>
        </CreatorResponsiveLayout>
        </CreatorModeHost>
      </div>

      {/* Emotes — floating widget near the table actions; its own bubbles
          appear next to it (crash-arena players are all at one table). */}
      {table && table.players.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50">
          <EmotePicker
            compact
            incomingEmote={incomingEmote}
            myEmote={myEmote}
            onSend={(emote) => sendEmote(emote)}
          />
        </div>
      )}

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
    </DailyLossGuard>
  );
}
