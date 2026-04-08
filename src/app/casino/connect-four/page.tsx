"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useSocket } from "../../../context/SocketProvider";
import NavigationBar from "../../../components/navigation-bar";

export default function ConnectFourLobbyPage() {
  const { isSignedIn, user } = useUser();
  const { socket } = useSocket();
  const router = useRouter();

  const [betAmount, setBetAmount] = useState(10);
  const [balance, setBalance] = useState(0);
  const [loading, setLoading] = useState(false);
  const [availableGames, setAvailableGames] = useState<any[]>([]);
  const [joiningId, setJoiningId] = useState<number | null>(null);

  const fetchBalance = async () => {
    if (!user) return;
    const response = await fetch("/api/get-user-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    });
    const data = await response.json();
    if (data.success) setBalance(Number(data.data.balance || 0));
  };

  const fetchGames = async () => {
    const res = await fetch("/api/connect-four/available-games", { cache: "no-store" });
    const data = await res.json();
    if (data.success) setAvailableGames(data.games || []);
  };

  useEffect(() => {
    if (isSignedIn && user) fetchBalance();
    fetchGames();
  }, [isSignedIn, user]);

  useEffect(() => {
    if (!socket) return;
    const roomId = "lobby:connect-four";
    const refresh = () => fetchGames();

    socket.emit("join_room", { roomId });
    socket.on("lobby:updated", refresh);

    return () => {
      socket.emit("leave_room", { roomId });
      socket.off("lobby:updated", refresh);
    };
  }, [socket]);

  const createGame = async () => {
    if (betAmount <= 0 || betAmount > balance) {
      alert("Invalid bet amount");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/connect-four/create-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ betAmount }),
      });
      const data = await res.json();

      if (!res.ok) {
        alert(data.error || "Unable to create game");
        return;
      }

      socket?.emit("room_event", { roomId: "lobby:connect-four", event: "lobby:updated" });
      router.push(`/casino/connect-four/game/${data.gameId}`);
    } finally {
      setLoading(false);
    }
  };

  const joinGame = async (gameId?: number) => {
    setLoading(true);
    if (gameId) setJoiningId(gameId);

    try {
      const res = await fetch("/api/connect-four/join-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(gameId ? { gameId } : { quickJoin: true }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        alert(data.error || "Unable to join game");
        return;
      }

      socket?.emit("room_event", { roomId: "lobby:connect-four", event: "lobby:updated" });
      router.push(`/casino/connect-four/game/${data.gameId}`);
    } finally {
      setLoading(false);
      setJoiningId(null);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#06264c] to-[#021228] text-white px-6 py-8">
      <NavigationBar currentPath="/casino" />
      <div className="max-w-4xl mx-auto mt-12">
        <h1 className="text-4xl font-extrabold text-center text-yellow-300 mb-3">🟡🔴 Connect Four Lobby</h1>
        <p className="text-center text-white/80 mb-8">Create, join, and wager in live multiplayer Connect Four games.</p>

        <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} className="bg-[#0a2f59]/80 border border-yellow-300/30 rounded-2xl p-6 shadow-2xl">
          <div className="text-center mb-4 text-lg">
            Balance: <span className="font-bold text-yellow-300">{balance.toFixed(2)}</span> tokens
          </div>

          <div className="grid md:grid-cols-3 gap-3 items-end">
            <div className="md:col-span-1">
              <label className="text-sm text-white/80">Bet amount</label>
              <input
                type="number"
                value={betAmount}
                min={1}
                max={balance}
                onChange={(e) => setBetAmount(Number(e.target.value))}
                className="w-full mt-1 p-3 rounded-lg bg-black/30 border border-white/20"
              />
            </div>
            <button onClick={createGame} disabled={loading} className="p-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-bold disabled:bg-emerald-900">
              {loading ? "Creating..." : "Create Game"}
            </button>
            <button onClick={() => joinGame()} disabled={loading} className="p-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 font-bold disabled:bg-indigo-900">
              {loading ? "Joining..." : "Quick Join"}
            </button>
          </div>
        </motion.div>

        <div className="mt-6 bg-[#0a2f59]/80 border border-yellow-300/20 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-bold text-yellow-300">Available Games</h2>
            <button onClick={fetchGames} className="px-3 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-sm">Refresh</button>
          </div>

          {availableGames.length === 0 ? (
            <p className="text-white/70">No open games right now.</p>
          ) : (
            <div className="space-y-3">
              {availableGames.map((game) => (
                <div key={game.id} className="flex items-center justify-between rounded-xl bg-black/30 p-3 border border-white/10">
                  <div>
                    <p className="font-semibold">Game #{game.id}</p>
                    <p className="text-sm text-white/75">Host: {game.hostName || "Player"} · Bet: {Number(game.betAmount).toFixed(2)}</p>
                  </div>
                  <button
                    onClick={() => joinGame(game.id)}
                    disabled={loading || joiningId === game.id}
                    className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 font-bold disabled:bg-blue-900"
                  >
                    {joiningId === game.id ? "Joining..." : "Join"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
