"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import NavigationBar from "../../../../../components/navigation-bar";

type Owner = "neutral" | "player1" | "player2";
type ActionType = "attack" | "reinforce" | "fortify";
type Tile = {
  x: number;
  y: number;
  owner: Owner;
  troops: number;
  shield: number;
  capital?: boolean;
};
type PlayerState = { userId?: string; tilesOwned: number; energy: number };
type State = {
  turnNumber: number;
  status: string;
  winner?: "player1" | "player2" | null;
  grid: Tile[][];
  playerStates: { player1: PlayerState; player2: PlayerState };
};

const ACTIONS: Array<{ id: ActionType; label: string; cost: number; description: string }> = [
  { id: "attack", label: "Attack", cost: 2, description: "Damage shields, then troops. Conquer at zero." },
  { id: "reinforce", label: "Reinforce", cost: 1, description: "Add one troop to an adjacent owned territory." },
  { id: "fortify", label: "Fortify", cost: 1, description: "Add one shield to an adjacent owned territory." },
];

function normalizeState(raw: State | null): State | null {
  if (!raw?.grid) return raw;

  const grid = raw.grid.map((row, y) =>
    row.map((tile, x) => {
      const capital =
        tile.capital ||
        (tile.owner === "player1" && x === 0 && y === 0) ||
        (tile.owner === "player2" && x === raw.grid.length - 1 && y === row.length - 1);
      return {
        ...tile,
        x: tile.x ?? x,
        y: tile.y ?? y,
        troops: tile.troops,
        shield: typeof tile.shield === "number" ? tile.shield : 0,
        capital: capital || undefined,
      };
    }),
  );

  const player1Tiles = grid.flat().filter((tile) => tile.owner === "player1").length;
  const player2Tiles = grid.flat().filter((tile) => tile.owner === "player2").length;

  return {
    ...raw,
    grid,
    playerStates: {
      player1: {
        ...raw.playerStates.player1,
        tilesOwned: player1Tiles,
        energy: raw.playerStates.player1.energy ?? 3,
      },
      player2: {
        ...raw.playerStates.player2,
        tilesOwned: player2Tiles,
        energy: raw.playerStates.player2.energy ?? 3,
      },
    },
  };
}

function neighbors(grid: Tile[][], tile: Tile): Tile[] {
  const offsets = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];

  return offsets
    .map(([dx, dy]) => grid[tile.y + dy]?.[tile.x + dx])
    .filter((candidate): candidate is Tile => Boolean(candidate));
}

function hasOwnedNeighbor(grid: Tile[][], tile: Tile, owner: Owner) {
  return owner !== "neutral" && neighbors(grid, tile).some((candidate) => candidate.owner === owner);
}

export default function TerritoriesGamePage() {
  const params = useParams<{ matchId: string }>();
  const search = useSearchParams();
  const [state, setState] = useState<State | null>(null);
  const [selected, setSelected] = useState<{ x: number; y: number } | null>(null);
  const [actionType, setActionType] = useState<ActionType>("attack");
  const [resolvedMatchId, setResolvedMatchId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>("Choose a tactical order.");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadMatch = useCallback(
    async (matchId: string) => {
      const res = await fetch(`/api/neon-territory/get-match?matchId=${matchId}`, {
        cache: "no-store",
      });
      const data = await res.json();
      setState(normalizeState(data?.match?.gameState || null));
    },
    [],
  );

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
        setState(normalizeState(data.gameState));
      } else {
        setResolvedMatchId(params.matchId);
        await loadMatch(params.matchId);
      }
    })();
  }, [loadMatch, params.matchId, search]);

  useEffect(() => {
    if (!resolvedMatchId || state?.status === "finished") return;
    const timer = window.setInterval(() => {
      loadMatch(resolvedMatchId);
    }, 2500);

    return () => window.clearInterval(timer);
  }, [loadMatch, resolvedMatchId, state?.status]);

  const tiles = useMemo(() => state?.grid.flat() ?? [], [state]);
  const selectedTile = useMemo(
    () => (selected && state ? state.grid[selected.y]?.[selected.x] ?? null : null),
    [selected, state],
  );
  const actionMeta = ACTIONS.find((action) => action.id === actionType) ?? ACTIONS[0];

  const submitMove = async () => {
    if (!resolvedMatchId || !selected || !state) return;
    setIsSubmitting(true);
    setNotice("Locking order...");

    const res = await fetch("/api/neon-territory/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        matchId: resolvedMatchId,
        actionType,
        targetX: selected.x,
        targetY: selected.y,
      }),
    });
    const data = await res.json();
    setIsSubmitting(false);

    if (!res.ok) {
      setNotice(data?.error || "That order could not be locked.");
      return;
    }

    if (data?.waiting) {
      setNotice("Order locked. Waiting for opponent...");
      return;
    }

    if (data?.state) {
      setState(normalizeState(data.state));
      setSelected(null);
      setNotice("Turn resolved.");
    }
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-[#010510] via-[#031634] to-[#030916] p-4 pt-20 text-white">
      <NavigationBar currentPath="/casino" />
      <section className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[240px_minmax(0,1fr)_260px]">
        <aside className="rounded-lg border border-cyan-300/40 bg-cyan-500/10 p-4 shadow-[0_0_22px_rgba(34,211,238,0.18)]">
          <p className="text-xs uppercase tracking-[0.24em] text-cyan-200/80">Command Link</p>
          <p className="mt-3 text-3xl font-black text-cyan-100">Turn {state?.turnNumber ?? 0}</p>
          <p className="mt-1 text-sm text-cyan-100/75">
            {state?.status === "finished" ? `Winner: ${state.winner?.toUpperCase()}` : "Active tactical phase"}
          </p>
          <div className="mt-5 grid gap-3">
            {ACTIONS.map((action) => (
              <button
                key={action.id}
                onClick={() => setActionType(action.id)}
                className={`rounded-md border px-3 py-3 text-left transition ${
                  actionType === action.id
                    ? "border-cyan-200 bg-cyan-300/20 shadow-[0_0_18px_rgba(34,211,238,0.28)]"
                    : "border-white/10 bg-white/5 hover:border-cyan-300/60 hover:bg-cyan-400/10"
                }`}
              >
                <span className="flex items-center justify-between text-sm font-bold">
                  {action.label}
                  <span className="rounded border border-cyan-200/30 px-2 py-0.5 text-xs text-cyan-100">
                    {action.cost} EN
                  </span>
                </span>
                <span className="mt-1 block text-xs text-cyan-50/65">{action.description}</span>
              </button>
            ))}
          </div>
        </aside>

        <div className="rounded-xl border border-cyan-300/50 bg-gradient-to-b from-[#09254f] to-[#081327] p-3 shadow-[0_0_34px_rgba(0,229,255,0.28)] sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-fuchsia-200/75">Selected Order</p>
              <h1 className="text-2xl font-black text-white sm:text-3xl">{actionMeta.label}</h1>
            </div>
            <div className="rounded-md border border-fuchsia-300/40 bg-fuchsia-500/10 px-3 py-2 text-sm text-fuchsia-50">
              {notice}
            </div>
          </div>

          <div className="mx-auto grid w-full max-w-[620px] grid-cols-5 gap-2">
            {tiles.map((tile) => {
              const ownerClass =
                tile.owner === "player1"
                  ? "border-cyan-300 bg-cyan-500/25 text-cyan-50 shadow-[inset_0_0_18px_rgba(34,211,238,0.18)]"
                  : tile.owner === "player2"
                    ? "border-fuchsia-300 bg-fuchsia-500/25 text-fuchsia-50 shadow-[inset_0_0_18px_rgba(217,70,239,0.18)]"
                    : "border-slate-500 bg-slate-800/55 text-slate-200";
              const isSelected = selected?.x === tile.x && selected?.y === tile.y;
              const adjacentP1 = state ? hasOwnedNeighbor(state.grid, tile, "player1") : false;
              const adjacentP2 = state ? hasOwnedNeighbor(state.grid, tile, "player2") : false;
              const canBeAttacked = actionType === "attack" && tile.owner !== "neutral" ? true : actionType === "attack";
              const tacticalHint =
                canBeAttacked || (actionType !== "attack" && (adjacentP1 || adjacentP2))
                  ? "hover:scale-[1.03] hover:border-yellow-200"
                  : "";

              return (
                <button
                  key={`${tile.x}-${tile.y}`}
                  onClick={() => setSelected({ x: tile.x, y: tile.y })}
                  className={`relative aspect-square overflow-hidden rounded-md border ${ownerClass} ${tacticalHint} ${
                    isSelected ? "ring-2 ring-yellow-300 shadow-[0_0_24px_rgba(253,224,71,0.42)]" : ""
                  } transition duration-200`}
                >
                  {tile.capital ? (
                    <span className="absolute left-1 top-1 rounded-sm border border-yellow-200/70 bg-yellow-300/20 px-1 text-[9px] font-black text-yellow-100">
                      CAP
                    </span>
                  ) : null}
                  <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-current opacity-70" />
                  <span className="flex h-full flex-col items-center justify-center gap-1">
                    <span className="text-lg font-black leading-none sm:text-2xl">{tile.troops}</span>
                    <span className="rounded border border-white/15 bg-black/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">
                      SH {tile.shield}
                    </span>
                  </span>
                  {isSelected ? <span className="absolute inset-0 animate-pulse bg-yellow-300/10" /> : null}
                </button>
              );
            })}
          </div>

          <div className="mt-4 flex flex-col gap-3 rounded-lg border border-white/10 bg-black/20 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-cyan-50/80">
              Target:{" "}
              <span className="font-bold text-white">
                {selectedTile
                  ? `${selectedTile.owner.toUpperCase()} (${selectedTile.x}, ${selectedTile.y}) - ${selectedTile.troops} troops / ${selectedTile.shield} shield`
                  : "None"}
              </span>
            </div>
            <button
              onClick={submitMove}
              disabled={!selected || isSubmitting || state?.status === "finished"}
              className="rounded-md bg-gradient-to-r from-cyan-300 via-blue-400 to-fuchsia-400 px-5 py-3 font-black text-black shadow-[0_0_18px_rgba(34,211,238,0.35)] transition hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-45"
            >
              {isSubmitting ? "Locking..." : "Lock Order"}
            </button>
          </div>
        </div>

        <aside className="rounded-lg border border-fuchsia-300/40 bg-fuchsia-500/10 p-4 shadow-[0_0_22px_rgba(217,70,239,0.18)]">
          <p className="text-xs uppercase tracking-[0.24em] text-fuchsia-200/80">War Room</p>
          <div className="mt-4 grid gap-3">
            <div className="rounded-md border border-cyan-300/30 bg-cyan-400/10 p-3">
              <p className="text-sm font-bold text-cyan-100">Player 1</p>
              <p className="mt-2 text-2xl font-black">{state?.playerStates.player1.tilesOwned ?? 0} tiles</p>
              <p className="text-sm text-cyan-50/75">{state?.playerStates.player1.energy ?? 0}/10 energy</p>
            </div>
            <div className="rounded-md border border-fuchsia-300/30 bg-fuchsia-400/10 p-3">
              <p className="text-sm font-bold text-fuchsia-100">Player 2</p>
              <p className="mt-2 text-2xl font-black">{state?.playerStates.player2.tilesOwned ?? 0} tiles</p>
              <p className="text-sm text-fuchsia-50/75">{state?.playerStates.player2.energy ?? 0}/10 energy</p>
            </div>
          </div>
          <div className="mt-4 rounded-md border border-white/10 bg-black/20 p-3 text-xs leading-5 text-white/65">
            Attacks burn shield before troops. Reinforce and fortify require an owned target connected to your front.
          </div>
        </aside>
      </section>
    </main>
  );
}
