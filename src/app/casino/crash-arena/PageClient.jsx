"use client";
import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import NavigationBar from "../../../components/navigation-bar";
import ArenaLobby from "../../../components/crash-arena/ArenaLobby";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";

/**
 * Crash Arena Lobby — /casino/crash-arena
 *
 * Fetches tables from /api/crash-arena/tables.
 * Clicking a table navigates to /casino/crash-arena/table/[tableId]
 */
export default function CrashArenaPage() {
  const { isSignedIn } = useUser();
  const router = useRouter();
  const [tables, setTables] = useState([]);
  const [userBalance, setUserBalance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [aiWager, setAiWager] = useState(null);
  const [aiError, setAiError] = useState(null);

  const fetchTables = useCallback(async () => {
    try {
      // mode=lobby returns a lighter payload (no per-table round/entries
      // N+1, no wait-lists/clerk ids) — the lobby grid only needs the
      // basic table info + round status. Socket pushes (lobby:updated)
      // still refresh instantly on join/create/settle.
      const res = await fetch("/api/crash-arena/tables?mode=lobby", { cache: "no-store" });
      const data = await res.json();
      if (data?.success) setTables(data.data || []);
    } catch {
      // silent
    }
  }, []);

  const fetchBalance = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const res = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (data?.success) setUserBalance(Number(data.data.balance));
    } catch {
      // silent
    }
  }, [isSignedIn]);

  // Start a free practice table against the GRYND AI bot for this wager
  // at the chosen difficulty (easy/medium/hard, like the poker AI seats).
  // Free play — no wallet deduction; the human gets a virtual stack.
  const playAI = useCallback(
    async (wager, difficulty) => {
      if (!isSignedIn) return;
      setAiWager(wager);
      setAiError(null);
      try {
        const res = await fetch("/api/crash-arena/create-ai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ wager, difficulty }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
          setAiError(data?.error || "Unable to start AI practice");
          return;
        }
        router.push(`/casino/crash-arena/table/${data.data.tableId}`);
      } catch {
        setAiError("Unable to start AI practice");
      } finally {
        setAiWager(null);
      }
    },
    [isSignedIn, router],
  );

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchTables(), fetchBalance()]).finally(() => setLoading(false));
    // Live socket pushes refresh the grid on table updates, so this HTTP
    // poll is a reconcile/safety net — 10s is plenty and halves the
    // previous 5s loneliness traffic for the lobby + balance.
    const interval = setInterval(() => {
      fetchTables();
      fetchBalance();
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchTables, fetchBalance]);

  return (
    <div className="flex min-h-screen flex-col items-center overflow-x-clip bg-gradient-to-b from-[#0a0118] to-[#061b3d] px-3 pb-24 pt-20 text-white sm:px-4 md:pb-8">
      <NavigationBar currentPath="/casino" />

      <div className="mt-4 w-full max-w-7xl lg:mt-8">
        {/* Back link */}
        <Link
          href="/casino"
          className="inline-flex items-center gap-1 text-sm text-cyan-100/70 hover:text-amber-300 mb-3 transition-colors"
        >
          ← Back to Games
        </Link>

        <ArenaLobby
          tables={tables}
          userBalance={userBalance}
          loading={loading}
          isSignedIn={isSignedIn}
          onRefresh={fetchTables}
          onPlayAI={playAI}
          aiWager={aiWager}
          aiError={aiError}
        />
      </div>
    </div>
  );
}
