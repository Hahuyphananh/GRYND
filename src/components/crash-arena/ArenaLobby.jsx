"use client";
import React, { useState, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import TableList, { CRASH_WAGERS } from "./TableList";
import BuyInModal from "./BuyInModal";

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

  const [creatingWager, setCreatingWager] = useState(null);
  const [joinTarget, setJoinTarget] = useState(null); // table awaiting buy-in
  const [busyTableId, setBusyTableId] = useState(null);
  const [actionError, setActionError] = useState(null);

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
      router.push(`/casino/crash-arena/table/${data.data.tableId}`);
    } catch (err) {
      fail(err.message || "Unable to create table");
    } finally {
      setCreatingWager(null);
    }
  }, [isSignedIn, router, fail]);

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
      router.push(`/casino/crash-arena/table/${table.id}`);
    } catch (err) {
      setBusyTableId(null);
      fail(err.message || "Unable to join table");
    }
  }, [joinTarget, router, fail]);

  return (
    <div className="relative w-full">
      {/* Header */}
      <div className="mb-6 text-center">
        <h1 className="text-3xl font-extrabold tracking-tight text-[#f5ff3b] sm:text-4xl">
          🚀 Crash Arena
        </h1>
        <p className="mt-2 text-sm text-[#9dd8ff] opacity-80">
          Create a table or join an open one — survive the crash, claim the pot.
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

      {/* Action error banner */}
      {actionError && (
        <div className="mb-4 mx-auto max-w-xl px-4 py-2.5 rounded-xl bg-red-900/30 border border-red-400/40 text-red-300 text-sm text-center">
          {actionError}
        </div>
      )}

      {/* Table amount sections */}
      {loading && tables.length === 0 ? (
        <div className="flex items-center justify-center py-16">
          <span className="inline-block w-10 h-10 border-3 border-[#00e5ff] border-t-transparent rounded-full animate-spin" />
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
    </div>
  );
}
