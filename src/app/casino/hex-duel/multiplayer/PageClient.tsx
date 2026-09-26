"use client";
import { useCallback, useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import Link from "next/link";
import NavigationBar from "../../../../components/navigation-bar";
import { useHexAudio } from "../../../../lib/hexAudio";
import { IconEye } from "@tabler/icons-react";

export default function HexDuelMultiplayerPage() {
  const { isSignedIn } = useUser();
  const [games, setGames] = useState<any[]>([]);
  const [liveGames, setLiveGames] = useState<any[]>([]);
  const [spectatorCounts, setSpectatorCounts] = useState<Record<number, number>>({});
  // STAKES ARE RETIRED (src/lib/games/stakes.js): a game is free to create
  // and join, so there is no stake or balance to track on this lobby.
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const router = useRouter();
  // Audio matches the main Hex Duel game page (same `useHexAudio` lib).
  const audio = useHexAudio();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/hex-duel/multiplayer/available", { credentials: "include" });
      const data = await res.json();
      setGames(data.games || []);
      setLiveGames(data.liveGames || []);

      if (data.liveGames?.length > 0) {
        const counts: Record<number, number> = {};
        await Promise.all(
          data.liveGames.map(async (g: any) => {
            try {
              const cr = await fetch(`/api/spectators/count?gameKey=hex-duel&gameId=${g.id}`, { credentials: "include" });
              const cd = await cr.json();
              if (cd?.success) counts[g.id] = cd.count;
            } catch {}
          }),
        );
        setSpectatorCounts(counts);
      }
    } catch {
      setError("Failed to load games. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!isSignedIn) {
      setError("Please sign in to create a game.");
      audio.playPush();
      return;
    }
    setActionLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/hex-duel/multiplayer/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ wager: 0 }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || "Failed to create game");
        audio.playPush();
        return;
      }
      audio.playCapture();
      if (data?.gameId) router.push(`/casino/hex-duel?gameId=${data.gameId}&host=1`);
    } catch {
      setError("Network error. Please try again");
      audio.playPush();
    } finally {
      setActionLoading(false);
    }
  };

  const handleJoin = async (gameId: number) => {
    if (!isSignedIn) {
      setError("Please sign in to join a game.");
      audio.playPush();
      return;
    }
    setActionLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/hex-duel/multiplayer/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ gameId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || "Unable to join game");
        audio.playPush();
        await load();
        return;
      }
      audio.playCapture();
      if (data?.gameId) router.push(`/casino/hex-duel?gameId=${data.gameId}&host=0`);
    } catch {
      setError("Network error. Please try again");
      audio.playPush();
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-[#010510] via-[#031634] to-[#030916] p-6 pt-24 text-white">
      <NavigationBar currentPath="/casino" />
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-black text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 via-blue-400 to-fuchsia-400">
              Hex Duel Multiplayer Lobby
            </h1>
          </div>
          <Link
            href="/casino"
            className="rounded-lg border border-white/15 px-4 py-2 text-[11px] font-medium text-slate-400 hover:text-white hover:border-white/25 hover:bg-white/5 transition-all duration-200"
          >
            ← Back to Games
          </Link>
        </div>

        {/* Stakes are retired — nothing has to be put up to play. */}
        <div className="mb-4 text-center">
          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-emerald-300">
            Free play · no tokens at stake
          </span>
        </div>

        {/* Error display */}
        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-center">
            <p className="text-[11px] text-red-400 font-medium">{error}</p>
            <button
              onClick={() => setError(null)}
              className="mt-1 text-[10px] text-red-300 underline hover:text-red-200"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Stakes are retired — there is no stake to pick; create a game. */}
        <div className="mb-6 flex flex-wrap items-end gap-3">
          <button
            onClick={handleCreate}
            disabled={actionLoading}
            className="rounded-lg border border-cyan-400/40 px-4 py-1.5 text-[11px] font-medium hover:bg-cyan-500/20 transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {actionLoading ? (
              <>
                <span className="inline-block w-3 h-3 rounded-full border-2 border-cyan-400/30 border-t-cyan-400 animate-spin" />
                Creating...
              </>
            ) : (
              "Create Game"
            )}
          </button>

          <button
            onClick={load}
            disabled={loading}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-slate-400 hover:text-white transition disabled:opacity-40"
          >
            {loading ? (
              <span className="inline-block w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin align-middle mr-1" />
            ) : null}
            ↻ Refresh
          </button>
        </div>

        <h2 className="mb-2 text-xs uppercase text-slate-500 tracking-widest">Available Games</h2>
        <div className="space-y-1.5">
          {loading && games.length === 0 && (
            <p className="text-[11px] text-slate-500 py-4 text-center">Loading games…</p>
          )}
          {!loading && games.length === 0 && (
            <p className="text-[11px] text-slate-600 py-4 text-center">No open games. Create one to start!</p>
          )}
          {games.map((g) => (
            <div key={g.id} className="rounded-lg border border-white/10 p-2.5 flex justify-between items-center">
              <span className="text-[12px] text-slate-300">
                {g.hostName || "Player"} · Free play
              </span>
              <button
                onClick={() => handleJoin(g.id)}
                disabled={actionLoading}
                className="rounded-lg border border-cyan-400/40 px-3 py-1 text-[11px] text-cyan-300 hover:bg-cyan-500/20 transition disabled:opacity-40"
              >
                Join
              </button>
            </div>
          ))}
        </div>

        <h2 className="mt-8 mb-2 text-xs uppercase text-slate-500 tracking-widest">Live Games (Spectate)</h2>
        <div className="space-y-1.5">
          {!loading && liveGames.length === 0 && (
            <p className="text-[11px] text-slate-600 py-4 text-center">No games currently running.</p>
          )}
          {liveGames.map((g) => (
            <div key={g.id} className="rounded-lg border border-white/10 p-2.5 flex justify-between items-center">
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-slate-300">
                  #{g.id} · {g.hostName || "Player"} vs Opponent · Free play
                </span>
                {spectatorCounts[g.id] > 0 && (
                  <span className="text-[10px] text-purple-400 bg-purple-500/10 px-1.5 py-0.5 rounded-full">
                    <span className="inline-flex items-center gap-1"><IconEye size={12} /> {spectatorCounts[g.id]}</span>
                  </span>
                )}
              </div>
              <button
                onClick={() => router.push(`/casino/hex-duel?gameId=${g.id}&spectator=1`)}
                className="rounded-lg border border-purple-400/40 px-3 py-1 text-[11px] text-purple-300 hover:bg-purple-500/20 transition"
              >
                Spectate
              </button>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
