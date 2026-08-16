"use client";
import { useCallback, useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import Link from "next/link";
import NavigationBar from "../../../../components/navigation-bar";
import { CHIP_VALUES } from "../../../../lib/rouletteConfig";
import { IconEye } from "@tabler/icons-react";

export default function HexDuelMultiplayerPage() {
  const { isSignedIn } = useUser();
  const [games, setGames] = useState<any[]>([]);
  const [liveGames, setLiveGames] = useState<any[]>([]);
  const [spectatorCounts, setSpectatorCounts] = useState<Record<number, number>>({});
  const [wager, setWager] = useState(50);
  const [balance, setBalance] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const router = useRouter();

  const fetchBalance = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const res = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (data.success) setBalance(Number(data.data.balance || 0));
    } catch {}
  }, [isSignedIn]);

  useEffect(() => { fetchBalance(); }, [fetchBalance]);

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
    if (wager <= 0) {
      setError("Please enter a valid wager amount.");
      return;
    }
    if (!isSignedIn) {
      setError("Please sign in to create a game.");
      return;
    }
    if (wager > balance) {
      setError(`Insufficient balance. You need ${wager.toLocaleString()} tokens.`);
      return;
    }
    setActionLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/hex-duel/multiplayer/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ wager }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || "Failed to create game");
        return;
      }
      if (data?.gameId) router.push(`/casino/hex-duel?gameId=${data.gameId}&host=1`);
    } catch {
      setError("Network error — please try again");
    } finally {
      setActionLoading(false);
    }
  };

  const handleJoin = async (gameId: number) => {
    if (!isSignedIn) {
      setError("Please sign in to join a game.");
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
        await load();
        return;
      }
      if (data?.gameId) router.push(`/casino/hex-duel?gameId=${data.gameId}&host=0`);
    } catch {
      setError("Network error — please try again");
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
            ← Back to Casino
          </Link>
        </div>

        {/* Balance display */}
        {isSignedIn && (
          <div className="mb-4 text-center">
            <p className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">Your Balance</p>
            <p className="text-xl font-black text-transparent bg-clip-text bg-gradient-to-r from-yellow-300 to-yellow-500">
              {balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
        )}

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

        {/* Wager controls */}
        <div className="mb-6 flex flex-wrap items-end gap-3">
          <div>
            <label className="text-[10px] text-slate-500 uppercase tracking-widest block mb-1">Wager</label>
            <input
              type="number"
              value={wager}
              min={0}
              onChange={(e) => {
                const val = e.target.value;
                if (val === "") { setWager(0); return; }
                setWager(Number(val) || 0);
              }}
              onBlur={() => { if (!wager || wager < 1) setWager(50); }}
              className="w-28 rounded-lg bg-black/30 border border-white/20 px-3 py-1.5 text-sm focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 outline-none transition"
              placeholder="Wager"
            />
          </div>

          {/* Quick chips */}
          <div className="flex flex-wrap gap-1">
            {CHIP_VALUES.map((val) => (
              <button
                key={val}
                onClick={() => setWager(val)}
                className={`px-2 py-0.5 rounded-full text-[10px] font-bold border transition-all ${
                  wager === val
                    ? "bg-[#FFFF33] text-black border-[#FFFF33]"
                    : "bg-[#0a1a3a] text-[#FFFF33]/80 border-[#FFFF33]/30 hover:bg-[#FFFF33]/20"
                }`}
              >
                {val}
              </button>
            ))}
          </div>

          {/* Bet action buttons */}
          <div className="flex gap-1">
            <button
              onClick={() => setWager(Math.max(1, Math.floor(balance / 2)))}
              className="px-2 py-1 rounded text-[10px] font-bold border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] hover:bg-[#FFFF33]/25"
            >
              ½
            </button>
            <button
              onClick={() => setWager(Math.max(1, balance))}
              className="px-2 py-1 rounded text-[10px] font-bold border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] hover:bg-[#FFFF33]/25"
            >
              ALL
            </button>
            <button
              onClick={() => setWager((prev) => Math.min(prev * 2, balance))}
              className="px-2 py-1 rounded text-[10px] font-bold border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] hover:bg-[#FFFF33]/25"
            >
              2×
            </button>
          </div>

          <button
            onClick={handleCreate}
            disabled={actionLoading || wager <= 0}
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
                {g.hostName || "Player"} · {Number(g.wagerAmount).toLocaleString(undefined, { minimumFractionDigits: 2 })} tokens
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
                  #{g.id} · {g.hostName || "Player"} vs Opponent · {Number(g.wagerAmount).toLocaleString(undefined, { minimumFractionDigits: 2 })} tokens
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
