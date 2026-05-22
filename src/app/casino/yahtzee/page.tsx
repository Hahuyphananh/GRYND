"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import NavigationBar from "../../../components/navigation-bar";

type LobbyRoom = {
  id: string;
  wager: number;
  status: string;
  createdAt?: string;
};

type GameState = {
  id: string;
  players: Array<{ userId: string; name: string; isAI?: boolean }>;
  currentTurn: string;
  rollsThisTurn: number;
  dice: number[];
  heldDice: boolean[];
  scorecards: Record<string, Record<string, number>>;
  state: string;
};

const categories = ["ones", "twos", "threes", "fours", "fives", "sixes", "threeOfKind", "fourOfKind", "fullHouse", "smallStraight", "largeStraight", "yahtzee", "chance"];

export default function YahtzeePage() {
  const { isSignedIn, user } = useUser();
  const router = useRouter();

  const [wager, setWager] = useState(100);
  const [balance, setBalance] = useState(0);
  const [loading, setLoading] = useState(false);
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [availableGames, setAvailableGames] = useState<LobbyRoom[]>([]);

  const [roomId, setRoomId] = useState<string | null>(null);
  const [game, setGame] = useState<GameState | null>(null);

  const fetchBalance = async () => {
    if (!user) return;
    const response = await fetch("/api/get-user-tokens", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include" });
    const data = await response.json();
    if (data.success) setBalance(Number(data.data.balance || 0));
  };

  const fetchGames = async () => {
    const res = await fetch("/api/yahtzee/state", { cache: "no-store" });
    const data = await res.json();
    if (data.success) setAvailableGames(data.rooms || []);
  };

  const fetchRoom = async (id: string) => {
    const res = await fetch(`/api/yahtzee/state?roomId=${encodeURIComponent(id)}`, { cache: "no-store" });
    const data = await res.json();
    if (data.success && data.room?.gameState) {
      setGame(data.room.gameState);
      return data.room.gameState as GameState;
    }
    return null;
  };

  useEffect(() => {
    if (isSignedIn && user) fetchBalance();
    fetchGames();
  }, [isSignedIn, user]);

  useEffect(() => {
    if (!roomId) return;
    const poll = setInterval(() => fetchRoom(roomId), 1500);
    return () => clearInterval(poll);
  }, [roomId]);

  const you = useMemo(() => {
    const uid = user?.id;
    return game?.players?.find((p) => p.userId === uid) || game?.players?.[0] || null;
  }, [game, user?.id]);

  const createGame = async () => {
    if (wager <= 0 || wager > balance) return alert("Invalid wager amount");
    setLoading(true);
    try {
      const res = await fetch("/api/yahtzee/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wager }) });
      const data = await res.json();
      if (!res.ok || !data.success) return alert(data.error || "Unable to create room");
      setRoomId(data.roomId);
      setGame(data.state);
      fetchGames();
    } finally {
      setLoading(false);
    }
  };

  const joinGame = async (id: string) => {
    setLoading(true);
    setJoiningId(id);
    try {
      const res = await fetch("/api/yahtzee/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomId: id }) });
      const data = await res.json();
      if (!res.ok || !data.success) return alert(data.error || "Unable to join room");
      setRoomId(id);
      setGame(data.state);
      fetchGames();
    } finally {
      setLoading(false);
      setJoiningId(null);
    }
  };

  const playAction = async (url: string, payload: Record<string, unknown>) => {
    if (!roomId) return;
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomId, ...payload }) });
    const data = await res.json();
    if (!res.ok || !data.success) return alert(data.error || "Action failed");
    setGame((data.state || data.finalState) as GameState);
  };

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />
      <div className="mx-auto mt-4 max-w-4xl sm:mt-8">
        <motion.h1 initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="mb-3 text-center text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-blue-400 to-purple-500 drop-shadow-[0_0_18px_rgba(0,229,255,0.6)] tracking-wide">YAHTZEE</motion.h1>
        <p className="mb-8 text-center text-white/80">Create, join, and wager in live multiplayer Yahtzee games.</p>

        <div className="rounded-2xl border border-[#00e5ff]/20 bg-[#0b224f]/70 p-6 shadow-[0_0_28px_rgba(0,229,255,0.2)]">
          <div className="mb-4 text-center text-lg">Balance: <span className="bg-gradient-to-r from-yellow-300 to-yellow-500 bg-clip-text font-bold text-transparent">{balance.toFixed(2)}</span> tokens</div>
          <div className="grid items-end gap-3 md:grid-cols-3">
            <div>
              <label className="text-sm text-white/80">Wager amount</label>
              <input type="number" value={wager} min={1} max={balance} onChange={(e) => setWager(Number(e.target.value || 0))} className="mt-1 w-full rounded-lg border border-[#00e5ff]/30 bg-[#020617] p-3 text-white outline-none" />
            </div>
            <button onClick={createGame} disabled={loading} className="rounded-xl bg-gradient-to-r from-yellow-200 to-yellow-600 p-3 font-bold text-black">{loading ? "Creating..." : "Create Game"}</button>
            <button onClick={() => router.refresh()} className="rounded-xl bg-gradient-to-r from-cyan-400 to-blue-500 p-3 font-bold text-[#001933]">Refresh Page</button>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-[#00e5ff]/30 bg-[#0b224f]/85 p-5 shadow-[0_0_22px_rgba(0,229,255,0.15)]">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-2xl font-bold text-[#FFD700]">Available Games</h2>
            <button onClick={fetchGames} className="rounded-lg bg-[#00e5ff] px-3 py-1 text-sm font-semibold text-[#001933]">Refresh</button>
          </div>
          {availableGames.length === 0 ? <p className="text-white/70">No open games right now.</p> : (
            <div className="space-y-3">{availableGames.map((lobby) => (
              <div key={lobby.id} className="flex items-center justify-between rounded-xl border border-[#00e5ff]/20 bg-[#08142f] p-3">
                <div>
                  <p className="font-semibold">Room {lobby.id}</p>
                  <p className="text-sm text-white/75">Wager: {Number(lobby.wager).toFixed(2)} · Status: {lobby.status}</p>
                </div>
                <button onClick={() => joinGame(lobby.id)} disabled={loading} className="rounded-lg bg-[#00e5ff] px-4 py-2 font-semibold text-[#001933]">{joiningId === lobby.id ? "Joining..." : "Join"}</button>
              </div>
            ))}</div>
          )}
        </div>

        {game && (
          <div className="mt-6 rounded-2xl border border-fuchsia-300/40 bg-black/30 p-4">
            <p className="mb-2">Turn: {game.currentTurn} · Rolls: {game.rollsThisTurn}/3</p>
            <div className="mb-3 flex gap-2">{(game.dice || []).map((d, i) => <button key={i} onClick={() => playAction("/api/yahtzee/hold", { heldDice: game.heldDice.map((v, idx) => idx === i ? !v : v) })} className={`h-14 w-14 rounded-lg border text-xl font-bold ${game.heldDice?.[i] ? "border-fuchsia-300 bg-fuchsia-500/40" : "border-cyan-200 bg-cyan-500/20"}`}>{d}</button>)}</div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => playAction("/api/yahtzee/roll", {})} className="rounded border border-yellow-300 bg-yellow-500/20 px-3 py-2">Roll Dice</button>
              {categories.map((c) => <button key={c} onClick={() => playAction("/api/yahtzee/choose-category", { category: c })} className="rounded border border-cyan-500/30 p-2 text-left hover:bg-cyan-500/10">{c}: {you ? game.scorecards?.[you.userId]?.[c] ?? "-" : "-"}</button>)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
