"use client";

import { useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import NavigationBar from "../../../../components/navigation-bar";
import AsyncState from "../../../../components/states/AsyncState";
import { SkeletonRows } from "../../../../components/skeletons/Skeleton";
import { useApiResource } from "../../../../hooks/useApiResource";
import {
  IconNotebook,
  IconDeviceGamepad2,
  IconCoins,
  IconTrophy,
  IconSkull,
  IconRobot,
  IconUser,
} from "@tabler/icons-react";

interface HexDuelGameRecord {
  id: number;
  player1Id: string;
  player2Id: string | null;
  wagerAmount: string;
  winner: string;
  result: string;
  payout: string | null;
  isAiGame: boolean;
  aiDifficulty: string | null;
  player1Moves: number;
  player2Moves: number;
  player1Territory: number;
  player2Territory: number;
  durationSeconds: number;
  status: string;
  isFunMode: boolean;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  // Perspective-aware fields supplied by /api/hex-duel/history:
  isHost?: boolean;
  viewerMoves?: number;
  opponentMoves?: number;
  viewerTerritory?: number;
  opponentTerritory?: number;
  opponentDisplayName?: string;
  opponentName?: string | null;
}

const PAGE_SIZE = 15;

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function HexDuelHistoryPage() {
  const { isSignedIn, isLoaded } = useUser();
  const router = useRouter();

  const [page, setPage] = useState(1);

  // Cache-first fetch with background revalidation, and a null key while Clerk
  // is still resolving (or the visitor is signed out) so nothing is requested
  // early. AsyncState turns the resource into skeleton / offline / error /
  // stale / empty states like every other data screen.
  const history = useApiResource<{
    success: boolean;
    data: {
      games: HexDuelGameRecord[];
      pagination: { totalPages: number; total: number };
    };
  }>(
    isLoaded && isSignedIn
      ? `/api/hex-duel/history?page=${page}&limit=${PAGE_SIZE}`
      : null,
  );

  const games = history.data?.data?.games ?? [];
  const total = history.data?.data?.pagination.total ?? 0;
  const totalPages = history.data?.data?.pagination.totalPages ?? 1;

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push("/casino/hex-duel");
  }, [isLoaded, isSignedIn, router]);

  if (!isLoaded) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#010510] via-[#031634] to-[#030916] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
      </div>
    );
  }

  if (!isSignedIn) return null;

  return (
    <main className="min-h-screen bg-gradient-to-br from-[#010510] via-[#031634] to-[#030916] p-4 pt-20 text-white">
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto max-w-4xl">
        {/* Header */}
        <div className="mb-6 text-center">
          <h1 className="text-3xl sm:text-4xl font-black text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 via-blue-400 to-fuchsia-400"
            style={{ filter: "drop-shadow(0 0 12px rgba(34,211,238,0.3))" }}>
            HEX DUEL: Match History
          </h1>
          <p className="mt-1 text-sm text-slate-400 uppercase tracking-[0.15em]">
            {total} game{total !== 1 ? "s" : ""} played
          </p>

          <button
            onClick={() => router.push("/casino/hex-duel")}
            className="mt-4 px-5 py-2 rounded-lg text-xs font-bold uppercase tracking-[0.12em] border border-white/15 text-slate-400 hover:text-white hover:border-white/30 hover:bg-white/5 transition-all duration-200"
          >
            ← Back to Game
          </button>
        </div>

        {/* Skeleton / offline / error / stale / empty are owned by the shared
            AsyncState, so this screen behaves like every other data screen. */}
        <AsyncState
          isLoading={history.isLoading}
          error={history.error}
          hasData={history.hasData}
          isEmpty={games.length === 0}
          onRetry={async () => {
            await history.refresh();
          }}
          cachedAt={history.cachedAt}
          skeleton={<SkeletonRows rows={6} label="Loading match history" />}
          empty={
            <div className="text-center py-16 rounded-xl border border-white/5 bg-white/[0.02] backdrop-blur-sm">
            <p className="mb-3 flex justify-center"><IconNotebook size={48} className="text-cyan-400/60" /></p>
            <p className="text-lg font-bold text-slate-300">No games played yet</p>
            <p className="text-sm text-slate-500 mt-1">Play a game of Hex Duel and your history will appear here</p>
            <button
              onClick={() => router.push("/casino/hex-duel")}
              className="mt-4 px-5 py-2 rounded-lg text-xs font-bold uppercase tracking-[0.12em] bg-gradient-to-r from-cyan-500 to-blue-600 text-white hover:shadow-[0_0_20px_rgba(34,211,238,0.4)] transition-all duration-200"
            >
              Play Now
            </button>
            </div>
          }
        >
            <div className="rounded-xl border border-white/5 bg-white/[0.02] overflow-hidden backdrop-blur-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/5 bg-white/[0.03]">
                      <th className="text-left px-4 py-3 text-[10px] text-slate-500 uppercase tracking-widest">#</th>
                      <th className="text-left px-4 py-3 text-[10px] text-slate-500 uppercase tracking-widest">Date</th>
                      <th className="text-left px-4 py-3 text-[10px] text-slate-500 uppercase tracking-widest">Mode</th>
                      <th className="text-right px-4 py-3 text-[10px] text-slate-500 uppercase tracking-widest">Wager</th>
                      <th className="text-center px-4 py-3 text-[10px] text-slate-500 uppercase tracking-widest">Result</th>
                      <th className="text-right px-4 py-3 text-[10px] text-slate-500 uppercase tracking-widest">Payout</th>
                      <th className="text-center px-4 py-3 text-[10px] text-slate-500 uppercase tracking-widest">You / Opp Moves</th>
                      <th className="text-center px-4 py-3 text-[10px] text-slate-500 uppercase tracking-widest">Duration</th>
                      <th className="text-center px-4 py-3 text-[10px] text-slate-500 uppercase tracking-widest">Opponent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {games.map((game) => {
                      const isWin = game.result === "win";
                      const isFun = game.isFunMode;

                      return (
                        <tr
                          key={game.id}
                          className="border-b border-white/[0.03] hover:bg-white/[0.04] transition-colors"
                        >
                          <td className="px-4 py-3 text-slate-500 text-xs font-mono">{game.id}</td>
                          <td className="px-4 py-3 text-slate-400 text-xs whitespace-nowrap">
                            {formatDate(game.createdAt)}
                          </td>
                          <td className="px-4 py-3">
                            <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                              isFun
                                ? "bg-purple-500/15 text-purple-300 border border-purple-500/30"
                                : "bg-yellow-500/10 text-yellow-400 border border-yellow-500/30"
                            }`}>
                              <span className="inline-flex items-center gap-1">{isFun ? <><IconDeviceGamepad2 size={12} /> Fun</> : <><IconCoins size={12} /> Real</>}</span>
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right text-xs text-slate-400 font-mono">
                            {isFun ? "-" : Number(game.wagerAmount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className={`text-xs font-bold uppercase px-2.5 py-1 rounded-md ${
                              isWin
                                ? "bg-green-500/15 text-green-300 border border-green-500/30"
                                : "bg-red-500/10 text-red-300 border border-red-500/30"
                            }`}>
                              <span className="inline-flex items-center gap-1">{isWin ? <><IconTrophy size={12} /> Win</> : <><IconSkull size={12} /> Loss</>}</span>
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right text-xs font-mono">
                            {isFun ? (
                              <span className="text-slate-600">-</span>
                            ) : isWin && game.payout ? (
                              <span className="text-green-400 font-bold">
                                +{Number(game.payout).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </span>
                            ) : (
                              <span className="text-red-400">
                                -{Number(game.wagerAmount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-center text-xs text-slate-400">
                            {game.viewerMoves ?? game.player1Moves} / {game.opponentMoves ?? game.player2Moves}
                          </td>
                          <td className="px-4 py-3 text-center text-xs text-slate-400">
                            {formatDuration(game.durationSeconds)}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {game.isAiGame ? (
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300 border border-purple-500/30 capitalize">
                                <span className="inline-flex items-center gap-1"><IconRobot size={12} /> {game.opponentDisplayName || `AI (${game.aiDifficulty || "medium"})`}</span>
                              </span>
                            ) : game.opponentDisplayName ? (
                              <span className="inline-flex items-center gap-1 text-[11px] text-slate-300"><IconUser size={12} /> {game.opponentDisplayName}</span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[10px] text-slate-500"><IconUser size={12} /> Human</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-center gap-3">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1 || history.isValidating}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold border border-white/10 text-slate-400 hover:text-white hover:border-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                >
                  ← Prev
                </button>
                <span className="text-xs text-slate-500">
                  Page {page} of {totalPages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages || history.isValidating}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold border border-white/10 text-slate-400 hover:text-white hover:border-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                >
                  Next →
                </button>
              </div>
            )}
        </AsyncState>
      </div>
    </main>
  );
}
