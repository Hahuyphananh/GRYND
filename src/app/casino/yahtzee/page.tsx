"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import NavigationBar from "../../../components/navigation-bar";

type LobbyRoom = { id: string; wager: number; status: string };
type Player = { userId: string; name: string; isAI?: boolean };
type GameState = {
  id: string;
  players: Player[];
  currentTurn: string;
  rollsThisTurn: number;
  dice: number[];
  heldDice: boolean[];
  scorecards: Record<string, Record<string, number>>;
  state: string;
};

const categories = [
  { key: "ones", label: "Ones" },
  { key: "twos", label: "Twos" },
  { key: "threes", label: "Threes" },
  { key: "fours", label: "Fours" },
  { key: "fives", label: "Fives" },
  { key: "sixes", label: "Sixes" },
  { key: "threeOfKind", label: "3 of a Kind" },
  { key: "fourOfKind", label: "4 of a Kind" },
  { key: "fullHouse", label: "Full House" },
  { key: "smallStraight", label: "Small Straight" },
  { key: "largeStraight", label: "Large Straight" },
  { key: "yahtzee", label: "Yahtzee" },
  { key: "chance", label: "Chance" },
];

export default function YahtzeePage() {
  const { isSignedIn, user } = useUser();
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
    if (data.success && data.room?.gameState) setGame(data.room.gameState as GameState);
  };

  useEffect(() => {
    if (isSignedIn && user) fetchBalance();
    fetchGames();
  }, [isSignedIn, user]);

  useEffect(() => {
    if (!roomId) return;
    fetchRoom(roomId);
    const poll = setInterval(() => fetchRoom(roomId), 1500);
    return () => clearInterval(poll);
  }, [roomId]);

  const you = useMemo(() => game?.players?.find((p) => p.userId === user?.id) || null, [game, user?.id]);
  const opponent = useMemo(() => game?.players?.find((p) => p.userId !== user?.id) || null, [game, user?.id]);
  const isYourTurn = Boolean(game && you && game.currentTurn === you.userId);

  const totalFor = (playerId?: string) => {
    if (!playerId || !game) return 0;
    return Object.values(game.scorecards?.[playerId] || {}).reduce((a, b) => a + Number(b || 0), 0);
  };

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
    } finally { setLoading(false); }
  };

  const joinGame = async (id: string) => {
    setLoading(true); setJoiningId(id);
    try {
      const res = await fetch("/api/yahtzee/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomId: id }) });
      const data = await res.json();
      if (!res.ok || !data.success) return alert(data.error || "Unable to join room");
      setRoomId(id); setGame(data.state); fetchGames();
    } finally { setLoading(false); setJoiningId(null); }
  };

  const playAction = async (url: string, payload: Record<string, unknown>) => {
    if (!roomId || !isYourTurn) return;
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomId, ...payload }) });
    const data = await res.json();
    if (!res.ok || !data.success) return alert(data.error || "Action failed");
    setGame((data.state || data.finalState) as GameState);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-200 via-yellow-200 to-orange-300 px-3 pb-24 pt-20 text-slate-900 sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />
      <div className="mx-auto mt-4 max-w-5xl sm:mt-8">
        <motion.h1 initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="mb-2 text-center text-5xl font-black tracking-wider text-blue-700 drop-shadow-[0_3px_0_rgba(255,255,255,0.7)]">YAHTZEE</motion.h1>
        <p className="mb-6 text-center font-semibold text-slate-700">Classic scorecard style multiplayer flow.</p>

        <div className="rounded-2xl border-4 border-blue-300 bg-white/85 p-5 shadow-xl">
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <div className="font-bold">Balance: {balance.toFixed(2)} tokens</div>
            <input type="number" value={wager} min={1} max={balance} onChange={(e) => setWager(Number(e.target.value || 0))} className="rounded border-2 border-blue-300 px-3 py-2" />
            <button onClick={createGame} disabled={loading} className="rounded bg-blue-600 px-4 py-2 font-bold text-white">{loading ? "Creating..." : "Create Game"}</button>
            <button onClick={fetchGames} className="rounded bg-amber-500 px-4 py-2 font-bold text-white">Refresh</button>
          </div>

          <div className="rounded-xl border-2 border-blue-200 bg-blue-50 p-4">
            <h2 className="mb-2 text-xl font-bold text-blue-700">Available Games</h2>
            {availableGames.length === 0 ? <p>No open games right now.</p> : availableGames.map((lobby) => (
              <div key={lobby.id} className="mb-2 flex items-center justify-between rounded bg-white p-2">
                <div className="text-sm font-semibold">{lobby.id} · Wager {Number(lobby.wager).toFixed(2)}</div>
                <button onClick={() => joinGame(lobby.id)} className="rounded bg-blue-600 px-3 py-1 text-white">{joiningId === lobby.id ? "Joining..." : "Join"}</button>
              </div>
            ))}
          </div>
        </div>

        {game && (
          <div className="mt-6 overflow-hidden rounded-2xl border-4 border-blue-400 bg-white shadow-2xl">
            <div className="bg-blue-600 px-4 py-3 text-white">
              <div className="font-bold">Room: {roomId}</div>
              <div className="text-sm">Turn: {isYourTurn ? "Your turn" : `${opponent?.name || "Opponent"}'s turn`} · Rolls: {game.rollsThisTurn}/3</div>
            </div>

            <div className="p-4">
              <div className="mb-4 flex flex-wrap gap-3">
                {(game.dice || []).map((d, i) => (
                  <button key={i} disabled={!isYourTurn} onClick={() => playAction("/api/yahtzee/hold", { heldDice: game.heldDice.map((v, idx) => idx === i ? !v : v) })} className={`h-16 w-16 rounded-xl border-2 text-2xl font-black ${game.heldDice?.[i] ? "border-red-500 bg-red-100" : "border-blue-300 bg-white"}`}>
                    {d}
                  </button>
                ))}
                <button disabled={!isYourTurn} onClick={() => playAction("/api/yahtzee/roll", {})} className="rounded bg-green-600 px-4 py-2 font-bold text-white disabled:opacity-50">Roll</button>
              </div>

              <div className="rounded-xl border-2 border-yellow-300">
                <div className="grid grid-cols-3 bg-yellow-200 p-2 font-bold">
                  <div>Category</div><div>{you?.name || "You"}</div><div>{opponent?.name || "Opponent"}</div>
                </div>
                {categories.map((c) => (
                  <div key={c.key} className="grid grid-cols-3 border-t border-yellow-200 p-2 text-sm">
                    <button disabled={!isYourTurn || !you || game.scorecards?.[you.userId]?.[c.key] !== undefined} onClick={() => playAction("/api/yahtzee/choose-category", { category: c.key })} className="text-left font-semibold text-blue-700 disabled:text-slate-400">{c.label}</button>
                    <div>{you ? (game.scorecards?.[you.userId]?.[c.key] ?? "—") : "—"}</div>
                    <div>{opponent ? (game.scorecards?.[opponent.userId]?.[c.key] ?? "—") : "—"}</div>
                  </div>
                ))}
                <div className="grid grid-cols-3 border-t-2 border-yellow-300 bg-yellow-50 p-2 font-bold">
                  <div>Total</div><div>{totalFor(you?.userId)}</div><div>{totalFor(opponent?.userId)}</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
