"use client";

// src/app/casino/lane-runner/history/page.jsx
//
// Match history for Lane Rush Duel — every finished match (PvP and
// Test vs Bot practice), viewer-perspective, paginated. Mirrors the
// hex-duel history page layout.

import { useCallback, useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import NavigationBar from "../../../../components/navigation-bar";
import {
  IconNotebook,
  IconTrophy,
  IconSkull,
  IconRobot,
  IconUser,
  IconFlag,
  IconCoins,
  IconMinus,
} from "@tabler/icons-react";

const PAGE_SIZE = 15;

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatMoney(n) {
  return Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function LaneRushDuelHistoryPage() {
  const { isSignedIn, isLoaded } = useUser();
  const router = useRouter();

  const [games, setGames] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchHistory = useCallback(async (p) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/lane-rush-duel/history?page=${p}&limit=${PAGE_SIZE}`,
        { credentials: "include" },
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || "Failed to load history");
        setGames([]);
        return;
      }
      setGames(data.data.games || []);
      setTotalPages(data.data.pagination.totalPages);
      setTotal(data.data.pagination.total);
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      router.push("/casino/lane-runner");
      return;
    }
    fetchHistory(page);
  }, [isLoaded, isSignedIn, page, fetchHistory, router]);

  if (!isLoaded) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#001933] to-[#000d1a]">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-cyan-400/30 border-t-cyan-400" />
      </div>
    );
  }

  if (!isSignedIn) return null;

  return (
    <main className="min-h-screen bg-gradient-to-br from-[#001933] via-[#011b36] to-[#000d1a] p-4 pt-20 text-white">
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto max-w-4xl">
        {/* Header */}
        <div className="mb-6 text-center">
          <h1
            className="bg-clip-text text-3xl font-black text-transparent bg-gradient-to-r from-cyan-300 via-cyan-400 to-fuchsia-400 sm:text-4xl"
            style={{ filter: "drop-shadow(0 0 12px rgba(34,211,238,0.3))" }}
          >
            LANE RUSH DUEL — Match History
          </h1>
          <p className="mt-1 text-sm uppercase tracking-[0.15em] text-slate-400">
            {total} match{total !== 1 ? "es" : ""} played
          </p>

          <button
            onClick={() => router.push("/casino/lane-runner")}
            className="mt-4 rounded-lg border border-white/15 px-5 py-2 text-xs font-bold uppercase tracking-[0.12em] text-slate-400 transition-all duration-200 hover:border-white/30 hover:bg-white/5 hover:text-white"
          >
            ← Back to Lobby
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-center">
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={() => fetchHistory(page)}
              className="mt-2 text-xs text-red-300 underline hover:text-red-200"
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading */}
        {loading && games.length === 0 && (
          <div className="flex items-center justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-cyan-400/30 border-t-cyan-400" />
          </div>
        )}

        {/* Empty state */}
        {!loading && games.length === 0 && !error && (
          <div className="rounded-xl border border-white/5 bg-white/[0.02] py-16 text-center backdrop-blur-sm">
            <p className="mb-3 flex justify-center">
              <IconNotebook size={48} className="text-cyan-400/60" />
            </p>
            <p className="text-lg font-bold text-slate-300">
              No matches played yet
            </p>
            <p className="mt-1 text-sm text-slate-500">
              Play a duel — or test the bot — and your history will appear
              here
            </p>
            <button
              onClick={() => router.push("/casino/lane-runner")}
              className="mt-4 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-5 py-2 text-xs font-bold uppercase tracking-[0.12em] text-white transition-all duration-200 hover:shadow-[0_0_20px_rgba(34,211,238,0.4)]"
            >
              Play Now
            </button>
          </div>
        )}

        {/* Games table */}
        {games.length > 0 && (
          <>
            <div className="overflow-hidden rounded-xl border border-white/5 bg-white/[0.02] backdrop-blur-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/5 bg-white/[0.03]">
                      <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-slate-500">#</th>
                      <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-slate-500">Date</th>
                      <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-slate-500">Mode</th>
                      <th className="px-4 py-3 text-left text-[10px] uppercase tracking-widest text-slate-500">Tower</th>
                      <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-slate-500">Wager</th>
                      <th className="px-4 py-3 text-center text-[10px] uppercase tracking-widest text-slate-500">Result</th>
                      <th className="px-4 py-3 text-right text-[10px] uppercase tracking-widest text-slate-500">Payout</th>
                      <th className="px-4 py-3 text-center text-[10px] uppercase tracking-widest text-slate-500">Final</th>
                      <th className="px-4 py-3 text-center text-[10px] uppercase tracking-widest text-slate-500">Opponent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {games.map((g) => (
                      <tr
                        key={g.id}
                        className="border-b border-white/[0.03] transition-colors hover:bg-white/[0.04]"
                      >
                        <td className="px-4 py-3 font-mono text-xs text-slate-500">{g.id}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-400">
                          {formatDate(g.createdAt)}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${
                              g.isBot
                                ? "border-purple-500/30 bg-purple-500/15 text-purple-300"
                                : "border-yellow-500/30 bg-yellow-500/10 text-yellow-400"
                            }`}
                          >
                            <span className="inline-flex items-center gap-1">
                              {g.isBot ? (
                                <>
                                  <IconRobot size={12} /> Practice
                                </>
                              ) : (
                                <>
                                  <IconCoins size={12} /> PvP
                                </>
                              )}
                            </span>
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs capitalize text-slate-300">
                          {g.difficulty}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-slate-400">
                          {g.isBot ? (
                            <span className="text-slate-600">—</span>
                          ) : (
                            formatMoney(g.stakeAmount)
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span
                            className={`rounded-md border px-2.5 py-1 text-xs font-bold uppercase ${
                              g.result === "win"
                                ? "border-green-500/30 bg-green-500/15 text-green-300"
                                : g.result === "draw"
                                  ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                                  : "border-red-500/30 bg-red-500/10 text-red-300"
                            }`}
                          >
                            <span className="inline-flex items-center gap-1">
                              {g.result === "win" ? (
                                <>
                                  <IconTrophy size={12} /> Win
                                </>
                              ) : g.result === "draw" ? (
                                <>
                                  <IconMinus size={12} /> Draw
                                </>
                              ) : (
                                <>
                                  <IconSkull size={12} /> Loss
                                </>
                              )}
                            </span>
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs">
                          {g.isBot ? (
                            <span className="text-slate-600">—</span>
                          ) : g.result === "win" ? (
                            <span className="font-bold text-green-400">
                              +{formatMoney(g.payout)}
                            </span>
                          ) : g.result === "draw" ? (
                            <span className="text-amber-300">
                              ±{formatMoney(g.payout)} refund
                            </span>
                          ) : (
                            <span className="text-red-400">
                              -{formatMoney(g.stakeAmount)}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className="inline-flex items-center gap-1 text-xs text-slate-300">
                            <span
                              className={`rounded bg-cyan-500/15 px-1.5 py-0.5 font-bold text-cyan-300 ${
                                g.myHeld ? "ring-1 ring-amber-300/50" : ""
                              }`}
                              title={`Level ${g.myLane}${g.myHeld ? " (banked)" : ""}`}
                            >
                              {Number(g.myPoints).toLocaleString()} pts
                            </span>
                            <IconFlag size={11} className="text-white/30" />
                            <span
                              className={`rounded bg-rose-500/15 px-1.5 py-0.5 font-bold text-rose-300 ${
                                g.oppHeld ? "ring-1 ring-amber-300/50" : ""
                              }`}
                              title={`Level ${g.oppLane}${g.oppHeld ? " (banked)" : ""}`}
                            >
                              {Number(g.oppPoints).toLocaleString()} pts
                            </span>
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          {g.isBot ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-purple-500/30 bg-purple-500/15 px-2 py-0.5 text-[10px] font-bold capitalize text-purple-300">
                              <IconRobot size={12} /> {g.opponentName}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[11px] text-slate-300">
                              <IconUser size={12} /> {g.opponentName}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-center gap-3">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1 || loading}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-bold text-slate-400 transition-all hover:border-white/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                >
                  ← Prev
                </button>
                <span className="text-xs text-slate-500">
                  Page {page} of {totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages || loading}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-bold text-slate-400 transition-all hover:border-white/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
