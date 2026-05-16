"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import NavigationBar from "../../../../../components/navigation-bar";

type Tile = { x: number; y: number; owner: "neutral" | "player1" | "player2"; hp: number };
type State = {
  turnNumber: number;
  status: string;
  grid: Tile[][];
  playerStates: { player1: { tilesOwned: number }; player2: { tilesOwned: number } };
};

export default function TerritoriesGamePage() {
  const params = useParams<{ matchId: string }>();
  const search = useSearchParams();
  const [state, setState] = useState<State | null>(null);
  const [selected, setSelected] = useState<{ x: number; y: number } | null>(null);
  const [resolvedMatchId, setResolvedMatchId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      if (params.matchId === "ai") {
        const bet = Number(search.get("bet") || 10);
        const res = await fetch("/api/neon-territory/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ opponentId: "ai-bot", wagerAmount: bet, tokenType: "SC" }),
        });
        const data = await res.json();
        setResolvedMatchId(data.id);
        setState(data.gameState);
      } else {
        const res = await fetch(`/api/neon-territory/get-match?matchId=${params.matchId}`, {
          cache: "no-store",
        });
        const data = await res.json();
        setResolvedMatchId(params.matchId);
        setState(data?.match?.gameState || null);
      }
    })();
  }, [params.matchId, search]);

  const tiles = useMemo(() => state?.grid.flat() ?? [], [state]);

  const submitMove = async () => {
    if (!resolvedMatchId || !selected) return;
    const res = await fetch("/api/neon-territory/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchId: resolvedMatchId, targetX: selected.x, targetY: selected.y }),
    });
    const data = await res.json();
    if (data?.state) setState(data.state);
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-[#010510] via-[#031634] to-[#030916] p-4 text-white mt-8">
      <NavigationBar currentPath="/casino" />
      <section className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[220px_minmax(0,1fr)_220px]">
        <aside className="rounded-lg border border-cyan-300/40 bg-cyan-500/10 p-4">
          Turn: {state?.turnNumber ?? 0}
          <br />
          Status: {state?.status ?? "loading"}
        </aside>
        <div className="rounded-xl border border-cyan-300/50 bg-gradient-to-b from-[#09254f] to-[#081327] p-4 shadow-[0_0_30px_rgba(0,229,255,0.3)]">
          <div className="mx-auto grid w-full max-w-[560px] grid-cols-5 gap-2">
            {tiles.map((tile) => {
              const ownerClass =
                tile.owner === "player1"
                  ? "border-cyan-300 bg-cyan-500/30"
                  : tile.owner === "player2"
                    ? "border-fuchsia-300 bg-fuchsia-500/30"
                    : "border-slate-500 bg-slate-700/20";
              const isSelected = selected?.x === tile.x && selected?.y === tile.y;
              return (
                <button
                  key={`${tile.x}-${tile.y}`}
                  onClick={() => setSelected({ x: tile.x, y: tile.y })}
                  className={`aspect-square rounded-md border ${ownerClass} ${isSelected ? "ring-2 ring-yellow-300" : ""}`}
                >
                  <span className="text-xs font-semibold">{tile.hp}/2</span>
                </button>
              );
            })}
          </div>
          <button
            onClick={submitMove}
            className="mt-4 rounded bg-gradient-to-r from-cyan-400 to-blue-500 px-4 py-2 font-bold text-black"
          >
            Lock Move
          </button>
        </div>
        <aside className="rounded-lg border border-fuchsia-300/40 bg-fuchsia-500/10 p-4">
          P1 Tiles: {state?.playerStates.player1.tilesOwned ?? 0}
          <br />
          P2 Tiles: {state?.playerStates.player2.tilesOwned ?? 0}
        </aside>
      </section>
    </main>
  );
}
