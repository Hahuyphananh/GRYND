"use client";

import { useEffect, useMemo, useState } from "react";

type Tile = { x: number; y: number; owner: "neutral" | "player1" | "player2"; hp: number };

type State = { id?: string; turnNumber: number; grid: Tile[][]; playerStates: { player1: { tilesOwned: number }; player2: { tilesOwned: number } } };

export default function NeonTerritoryPage() {
  const [matchId, setMatchId] = useState<string | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [selected, setSelected] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/neon-territory/match", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ opponentId: "ai-bot", wagerAmount: 10, tokenType: "SC" }) });
      const data = await res.json();
      setMatchId(data.id);
      setState({ ...data.gameState, id: data.id });
    })();
  }, []);

  const tiles = useMemo(() => state?.grid.flat() ?? [], [state]);

  const submitMove = async () => {
    if (!matchId || !selected) return;
    const res = await fetch("/api/neon-territory/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ matchId, targetX: selected.x, targetY: selected.y }) });
    const data = await res.json();
    if (data?.state) setState(data.state);
  };

  return (
    <main className="min-h-screen bg-[#0a0a0f] text-white p-4">
      <nav className="mx-auto mb-6 flex max-w-5xl flex-wrap gap-2 rounded-xl border border-fuchsia-500/30 bg-black/40 p-3 text-sm">
        {['Home','Wallet / Tokens','Leaderboard','Games list','Profile'].map((item) => <span key={item} className="rounded bg-fuchsia-500/10 px-3 py-2">{item}</span>)}
      </nav>
      <section className="mx-auto grid max-w-5xl gap-4 lg:grid-cols-[220px_minmax(0,1fr)_220px]">
        <aside className="rounded-lg border border-cyan-400/30 p-4">Turn: {state?.turnNumber ?? 0}</aside>
        <div className="rounded-xl border border-fuchsia-400/40 bg-gradient-to-b from-[#13131f] to-[#09090d] p-4">
          <div className="mx-auto grid w-full max-w-[520px] grid-cols-5 gap-2">
            {tiles.map((tile) => {
              const ownerClass = tile.owner === "player1" ? "border-cyan-300 bg-cyan-500/20" : tile.owner === "player2" ? "border-pink-300 bg-pink-500/20" : "border-slate-500 bg-slate-700/30";
              const isSelected = selected?.x === tile.x && selected?.y === tile.y;
              return (
                <button key={`${tile.x}-${tile.y}`} onClick={() => setSelected({ x: tile.x, y: tile.y })} className={`aspect-square rounded-md border ${ownerClass} ${isSelected ? "animate-pulse ring-2 ring-yellow-300" : ""}`}>
                  <span className="text-xs">{tile.hp}/2</span>
                </button>
              );
            })}
          </div>
          <button onClick={submitMove} className="mt-4 rounded bg-fuchsia-500 px-4 py-2 font-semibold">Lock Attack</button>
        </div>
        <aside className="rounded-lg border border-pink-400/30 p-4">
          P1 Tiles: {state?.playerStates.player1.tilesOwned ?? 0}<br />P2 Tiles: {state?.playerStates.player2.tilesOwned ?? 0}
        </aside>
      </section>
    </main>
  );
}
