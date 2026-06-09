"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function HexDuelMultiplayerPage() {
  const [games, setGames] = useState<any[]>([]);
  const [liveGames, setLiveGames] = useState<any[]>([]);
  const [wager, setWager] = useState(50);
  const router = useRouter();
  const load = async () => {
    const res = await fetch('/api/hex-duel/multiplayer/available');
    const data = await res.json();
    setGames(data.games || []);
    setLiveGames(data.liveGames || []);
  };
  useEffect(() => { load(); }, []);
  return <main className="min-h-screen bg-gradient-to-br from-[#010510] via-[#031634] to-[#030916] p-6 pt-24 text-white">
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-black">Hex Duel Multiplayer Lobby</h1>
        </div>
        <Link
          href="/casino"
          className="rounded-lg border border-white/15 px-4 py-2 text-[11px] font-medium text-slate-400 hover:text-white hover:border-white/25 hover:bg-white/5 transition-all duration-200"
        >
          ← Back to Casino
        </Link>
      </div>

      <div className="mb-6 flex items-center gap-2">
        <input
          type="number"
          value={wager}
          onChange={(e) => setWager(Number(e.target.value) || 0)}
          className="w-24 rounded-lg bg-black/30 border border-white/20 px-3 py-1.5 text-sm"
          placeholder="Wager"
        />
        <button
          className="rounded-lg border border-cyan-400/40 px-3 py-1.5 text-[11px] font-medium hover:bg-cyan-500/20 transition"
          onClick={async () => {
            const res = await fetch('/api/hex-duel/multiplayer/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wager }) });
            const data = await res.json();
            if (data?.gameId) router.push(`/casino/hex-duel?gameId=${data.gameId}&host=1`);
          }}
        >
          Create Game
        </button>
        <button
          onClick={load}
          className="rounded-lg border border-white/15 px-3 py-1.5 text-[11px] text-slate-400 hover:text-white transition"
        >
          ↻ Refresh
        </button>
      </div>
      <h2 className="mb-2 text-xs uppercase text-slate-500 tracking-widest">Available Games</h2>
      <div className="space-y-1.5">
        {games.length === 0 && (
          <p className="text-[11px] text-slate-600 py-4 text-center">No open games. Create one to start!</p>
        )}
        {games.map((g) => (
          <div key={g.id} className="rounded-lg border border-white/10 p-2.5 flex justify-between items-center">
            <span className="text-[12px] text-slate-300">
              {g.hostName || "Player"} · {g.wagerAmount} tokens
            </span>
            <button
              onClick={async () => {
                const res = await fetch('/api/hex-duel/multiplayer/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gameId: g.id }) });
                const data = await res.json();
                if (data?.gameId) router.push(`/casino/hex-duel?gameId=${data.gameId}&host=0`);
              }}
              className="rounded-lg border border-cyan-400/40 px-3 py-1 text-[11px] text-cyan-300 hover:bg-cyan-500/20 transition"
            >
              Join
            </button>
          </div>
        ))}
      </div>

      <h2 className="mt-8 mb-2 text-xs uppercase text-slate-500 tracking-widest">Live Games (Spectate)</h2>
      <div className="space-y-1.5">
        {liveGames.length === 0 && (
          <p className="text-[11px] text-slate-600 py-4 text-center">No games currently running.</p>
        )}
        {liveGames.map((g) => (
          <div key={g.id} className="rounded-lg border border-white/10 p-2.5 flex justify-between items-center">
            <span className="text-[12px] text-slate-300">
              #{g.id} · {g.hostName || "Player"} vs Opponent · {g.wagerAmount} tokens
            </span>
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
}
