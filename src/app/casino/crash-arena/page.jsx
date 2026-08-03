"use client";
import React, { useState, useEffect, useCallback } from "react";
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
  const [tables, setTables] = useState([]);
  const [userBalance, setUserBalance] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchTables = useCallback(async () => {
    try {
      const res = await fetch("/api/crash-arena/tables", { cache: "no-store" });
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

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchTables(), fetchBalance()]).finally(() => setLoading(false));
    const interval = setInterval(() => {
      fetchTables();
      fetchBalance();
    }, 5000);
    return () => clearInterval(interval);
  }, [fetchTables, fetchBalance]);

  return (
    <div className="flex min-h-screen flex-col items-center overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-4 md:pb-8">
      <NavigationBar currentPath="/casino" />

      <div className="mt-4 w-full max-w-7xl lg:mt-8">
        {/* Back link */}
        <Link
          href="/casino"
          className="inline-flex items-center gap-1 text-sm text-[#9dd8ff] hover:text-[#00e5ff] mb-3 transition-colors"
        >
          ← Back to Casino
        </Link>

        <ArenaLobby
          tables={tables}
          userBalance={userBalance}
          loading={loading}
        />
      </div>

      {/* Rules section */}
      <div className="mt-6 w-full max-w-7xl bg-[#08142f] rounded-lg border border-[#00e5ff]/30 shadow-[0_0_14px_rgba(0,229,255,0.15)]">
        <details className="group">
          <summary className="w-full flex justify-between items-center px-4 py-2 font-bold text-[#FFD700] cursor-pointer list-none">
            📜 Crash Arena Rules
            <span className="group-open:hidden">▼</span>
            <span className="hidden group-open:inline">▲</span>
          </summary>
          <div className="px-4 pb-4 text-sm text-gray-300 space-y-2">
            <p>
              🚀 Every round, all players watch the multiplier climb. Cash out
              before it crashes to keep your share of the pot.
            </p>
            <p>
              💥 If you don&apos;t cash out before the crash, you lose your round
              wager.
            </p>
            <p>
              🏆 The highest cashout wins the pot (minus a 5% platform fee).
            </p>
            <p>
              💰 Minimum buy-in is <strong>5× the round wager</strong>. Buy in
              once, play multiple rounds. Leave anytime with your remaining
              balance.
            </p>
          </div>
        </details>
      </div>
    </div>
  );
}
