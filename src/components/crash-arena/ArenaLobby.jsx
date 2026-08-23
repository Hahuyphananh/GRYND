"use client";
import React, { useState, useMemo, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { IconBook, IconRocket } from "@tabler/icons-react";
import TableList, { CRASH_WAGERS } from "./TableList";
import BuyInModal from "./BuyInModal";
import CrashArenaRulesModal from "./CrashArenaRulesModal";
import { useSocket } from "../../context/SocketProvider";
import {
  CRASH_ARENA_LOBBY_ROOM,
  CRASH_ARENA_TABLE_UPDATED,
} from "../../lib/crash-arena/rooms";

/**
 * ArenaLobby — the main Crash Arena lobby.
 *
 * Tables are grouped by wager. Each wager section has a "Create Table"
 * button (creates a brand-new table for others to join) and an
 * "Available Games" list with Join buttons underneath.
 *
 * Props:
 *   tables      — array of table objects from API
 *   userBalance — player's wallet balance (null = loading)
 *   loading     — whether data is still loading
 *   isSignedIn  — whether the user is authenticated
 *   onRefresh   — () => void — re-fetch lobby data (after errors)
 */
export default function ArenaLobby({
  tables = [],
  userBalance = null,
  loading = false,
  isSignedIn = false,
  onRefresh,
}) {
  const router = useRouter();
  const { socket } = useSocket();

  const [creatingWager, setCreatingWager] = useState(null);
  const [joinTarget, setJoinTarget] = useState(null); // table awaiting buy-in
  const [busyTableId, setBusyTableId] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [showRules, setShowRules] = useState(false);

  // Group lobby tables by wager, always keeping all 6 standard sections.
  const grouped = useMemo(() => {
    const map = {};
    for (const w of CRASH_WAGERS) map[w] = [];
    for (const t of tables) {
      if (map[t.wager]) map[t.wager].push(t);
    }
    return map;
  }, [tables]);

  const fail = useCallback((msg) => {
    setActionError(msg);
    onRefresh?.();
  }, [onRefresh]);

  // ── Realtime lobby refresh ──────────────────────────────────────────
  // Join the shared lobby room so table create/join/leave events from
  // other players refresh this grid instantly (the 5 s poll stays as a
  // fallback for dropped sockets / separate-process deployments).
  useEffect(() => {
    if (!socket) return;
    const refresh = () => onRefresh?.();
    socket.emit("join_room", { roomId: CRASH_ARENA_LOBBY_ROOM });
    socket.on(CRASH_ARENA_TABLE_UPDATED, refresh);
    return () => {
      socket.off(CRASH_ARENA_TABLE_UPDATED, refresh);
      socket.emit("leave_room", { roomId: CRASH_ARENA_LOBBY_ROOM });
    };
  }, [socket, onRefresh]);

  // Best-effort fanout to the lobby room after a mutation.
  const emitLobbyUpdate = useCallback((payload) => {
    if (!socket) return;
    socket.emit("room_event", {
      roomId: CRASH_ARENA_LOBBY_ROOM,
      event: CRASH_ARENA_TABLE_UPDATED,
      payload: payload || {},
    });
  }, [socket]);

  // ── Create a brand-new table with the given wager ───────────────────────
  const handleCreate = useCallback(async (wager) => {
    setActionError(null);
    if (!isSignedIn) {
      setActionError("Please sign in to create a table.");
      return;
    }
    setCreatingWager(wager);
    try {
      const res = await fetch("/api/crash-arena/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ wager }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Unable to create table");
      }
      emitLobbyUpdate({ created: true, wager });
      router.push(`/casino/crash-arena/table/${data.data.tableId}`);
    } catch (err) {
      fail(err.message || "Unable to create table");
    } finally {
      setCreatingWager(null);
    }
  }, [isSignedIn, router, fail, emitLobbyUpdate]);

  // ── Open the buy-in modal for a table from the Available Games list ─────
  const handleJoin = useCallback((table) => {
    setActionError(null);
    if (!isSignedIn) {
      setActionError("Please sign in to join a table.");
      return;
    }
    setJoinTarget(table);
  }, [isSignedIn]);

  // ── Complete the join with the chosen buy-in amount ─────────────────────
  const handleBuyIn = useCallback(async (amount) => {
    const table = joinTarget;
    setJoinTarget(null);
    if (!table) return;

    setBusyTableId(table.id);
    setActionError(null);
    try {
      const res = await fetch("/api/crash-arena/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ tableId: table.id, buyInAmount: amount }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Unable to join table");
      }
      emitLobbyUpdate({ joined: true, tableId: table.id });
      router.push(`/casino/crash-arena/table/${table.id}`);
    } catch (err) {
      setBusyTableId(null);
      fail(err.message || "Unable to join table");
    }
  }, [joinTarget, router, fail, emitLobbyUpdate]);

  return (
    <div className="relative w-full">
      {/* Header */}
      <div className="mb-6 text-center">
        <h1 className="text-3xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-amber-300 via-amber-400 to-yellow-500 drop-shadow-[0_0_18px_rgba(251,191,36,0.5)] sm:text-4xl">
          <IconRocket size={30} className="mb-1.5 mr-2 inline" /> Crash Arena
        </h1>
        <p className="mt-2 text-sm text-white/60">
          Create a table or join an open one. Survive the crash, claim the pot.
        </p>
        {/* Rules popup button */}
        <button
          onClick={() => setShowRules(true)}
          className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 hover:scale-105 transition-all duration-300 shadow-[0_0_14px_rgba(251,191,36,0.15)]"
        >
          <IconBook size={15} /> How to Play
        </button>
      </div>

      {/* Balance bar */}
      <div className="mb-6 flex items-center justify-center gap-3 px-4 py-3 rounded-2xl border border-amber-700/60 bg-black/40 backdrop-blur-sm max-w-sm mx-auto">
        <span className="text-white/55 text-sm">Your Balance</span>
        <span className="text-xl font-black text-yellow-300 drop-shadow-[0_0_10px_rgba(251,191,36,0.5)]">
          {loading && userBalance === null
            ? "..."
            : `$${(userBalance ?? 0).toLocaleString()}`}
        </span>
      </div>

      {/* Action error banner */}
      {actionError && (
        <div className="mb-4 mx-auto max-w-xl px-4 py-2.5 rounded-xl bg-red-900/30 border border-red-400/40 text-red-300 text-sm text-center">
          {actionError}
        </div>
      )}

      {/* Table amount sections */}
      {loading && tables.length === 0 ? (
        <div className="flex items-center justify-center py-16">
          <span className="inline-block w-10 h-10 border-3 border-amber-400 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <TableList
          grouped={grouped}
          isSignedIn={isSignedIn}
          creating={creatingWager}
          busyTableId={busyTableId}
          onCreate={handleCreate}
          onJoin={handleJoin}
        />
      )}

      {/* Buy-in modal for joining from the available games list */}
      {joinTarget && (
        <BuyInModal
          table={{ wager: joinTarget.wager, minBuyIn: joinTarget.minBuyIn }}
          maxBalance={userBalance}
          onBuyIn={handleBuyIn}
          onClose={() => setJoinTarget(null)}
        />
      )}

      {/* Rules popup */}
      {showRules && <CrashArenaRulesModal onClose={() => setShowRules(false)} />}
    </div>
  );
}
