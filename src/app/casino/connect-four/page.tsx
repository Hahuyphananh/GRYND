"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { usePostHog } from "posthog-js/react";
import { useSocket } from "../../../context/SocketProvider";
import NavigationBar from "../../../components/navigation-bar";
import Footer from "../../../components/Footer";
import { IconRobot, IconDeviceGamepad2 } from "@tabler/icons-react";

export default function ConnectFourLobbyPage() {
  const { isSignedIn, user } = useUser();
  const { socket } = useSocket();
  const router = useRouter();
  const posthog = usePostHog();

  const [betAmount, setBetAmount] = useState(10);
  const [timerSeconds, setTimerSeconds] = useState(60);
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
    const res = await fetch("/api/connect-four/available-games", {
      cache: "no-store",
    });
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
        body: JSON.stringify({ betAmount, timerSeconds }),
      });
      const data = await res.json();

      if (!res.ok) {
        alert(data.error || "Unable to create game");
        return;
      }

      socket?.emit("room_event", {
        roomId: "lobby:connect-four",
        event: "lobby:updated",
      });
      router.push(`/casino/connect-four/game/${data.gameId}`);
      posthog?.capture("connect_four_game_started", { mode: "create", bet_amount: betAmount, game_id: data.gameId, timer_seconds: timerSeconds });
    } finally {
      setLoading(false);
    }
  };

  const playVsAi = () => {
    if (!isSignedIn) {
      alert("Please sign in to play vs AI.");
      return;
    }
    posthog?.capture("connect_four_game_started", { mode: "ai" });
    router.push("/casino/connect-four/play-ai");
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

      socket?.emit("room_event", {
        roomId: "lobby:connect-four",
        event: "lobby:updated",
      });
      router.push(`/casino/connect-four/game/${data.gameId}`);
      posthog?.capture("connect_four_game_started", { mode: gameId ? "join" : "quick_join", game_id: data.gameId });
    } finally {
      setLoading(false);
      setJoiningId(null);
    }
  };

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />
      <div className="mx-auto mt-4 max-w-4xl sm:mt-8">
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <h1
            className="text-3xl sm:text-4xl font-extrabold text-center mb-2
  text-transparent bg-clip-text
  bg-gradient-to-r from-cyan-400 via-blue-400 to-purple-500
  drop-shadow-[0_0_18px_rgba(0,229,255,0.6)] tracking-wide"
          >
            CONNECT FOUR
          </h1>
        </motion.div>
        <p className="text-center text-sm text-white/60 mb-7 max-w-xl mx-auto">
          Create, join, and wager in live multiplayer Connect Four games. Or
          play the AI for free.
        </p>

        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-[#0b224f]/70 backdrop-blur-xl 
border border-[#00e5ff]/20 
shadow-[0_0_40px_rgba(0,229,255,0.15)] rounded-2xl p-6 shadow-[0_0_28px_rgba(0,229,255,0.2)]"
        >
          <div className="text-center mb-4 text-sm">
            <span className="uppercase tracking-wider text-[11px] text-white/50 mr-2">
              Balance
            </span>
            <span className="font-bold text-transparent bg-clip-text bg-gradient-to-r from-yellow-300 to-yellow-500 text-base">
              {balance.toFixed(2)}
            </span>{" "}
            <span className="text-white/50">tokens</span>
          </div>

          <div className="grid md:grid-cols-4 gap-3 items-end">
            <div className="md:col-span-1">
              <label className="text-[11px] uppercase tracking-wider text-white/60">
                Bet amount
              </label>
              <input
                type="number"
                value={betAmount}
                min={1}
                max={balance}
                onChange={(e) => setBetAmount(Number(e.target.value))}
                className="w-full mt-1 p-2.5 rounded-lg text-sm
bg-[#020617] border border-[#00e5ff]/30
focus:border-[#00e5ff] focus:ring-0
outline-none text-white"
              />
            </div>
            <div className="md:col-span-1">
              <label className="text-[11px] uppercase tracking-wider text-white/60">
                Turn timer
              </label>
              <select
                value={timerSeconds}
                onChange={(e) => setTimerSeconds(Number(e.target.value))}
                className="w-full mt-1 p-2.5 rounded-lg text-sm
bg-[#020617] border border-[#00e5ff]/30
focus:border-[#00e5ff] focus:ring-0
outline-none text-white"
              >
                <option value={10}>10 seconds</option>
                <option value={30}>30 seconds</option>
                <option value={60}>60 seconds</option>
                <option value={120}>120 seconds</option>
              </select>
            </div>
            <button
              onClick={createGame}
              disabled={loading}
              className="p-2.5 rounded-xl text-sm font-bold text-black
bg-gradient-to-r from-yellow-200 to-yellow-600
hover:scale-105 active:scale-95
transition-all duration-150
shadow-[0_0_18px_rgba(255,215,0,0.6)] disabled:opacity-50 disabled:hover:scale-100"
            >
              {loading ? "Creating..." : "Create Game"}
            </button>
            <button
              onClick={() => joinGame()}
              disabled={loading}
              className="p-2.5 rounded-xl text-sm font-bold text-[#001933]
bg-gradient-to-r from-cyan-400 to-blue-500
hover:scale-105 active:scale-95
transition-all duration-150
shadow-[0_0_18px_rgba(0,229,255,0.6)] disabled:opacity-50 disabled:hover:scale-100"
            >
              {loading ? "Joining..." : "Quick Join"}
            </button>
          </div>

          <div className="relative my-5 flex items-center gap-3">
            <div className="flex-1 h-px bg-gradient-to-r from-transparent via-[#00e5ff]/30 to-transparent" />
            <span className="text-[10px] uppercase tracking-[0.3em] text-white/40">
              or
            </span>
            <div className="flex-1 h-px bg-gradient-to-r from-transparent via-[#00e5ff]/30 to-transparent" />
          </div>

          <button
            onClick={playVsAi}
            disabled={loading}
            className="group w-full p-3 rounded-xl text-sm font-bold text-white
bg-gradient-to-r from-fuchsia-500 via-purple-500 to-indigo-500
hover:scale-[1.02] active:scale-95
transition-all duration-200
shadow-[0_0_22px_rgba(168,85,247,0.45)]
border border-purple-300/30
flex items-center justify-center gap-2 disabled:opacity-50 disabled:hover:scale-100"
          >
            <IconRobot size={18} aria-hidden />
            <span className="tracking-wide">Play vs AI — Free, no wager</span>
            <span aria-hidden className="text-base group-hover:translate-x-0.5 transition-transform">→</span>
          </button>
        </motion.div>

        <div className="mt-6 bg-[#0b224f]/85 border border-[#00e5ff]/30 rounded-2xl p-5 shadow-[0_0_22px_rgba(0,229,255,0.15)]">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-[#FFD700] flex items-center gap-2 uppercase tracking-wider">
              <IconDeviceGamepad2 size={18} aria-hidden />
              <span>Available Games</span>
            </h2>
            <button
              onClick={fetchGames}
              className="px-3 py-1.5 rounded-lg bg-[#00e5ff] text-[#001933] hover:bg-[#49eeff] text-xs font-semibold shadow-[0_0_10px_rgba(0,229,255,0.35)] transition-colors"
            >
              Refresh
            </button>
          </div>

          {availableGames.length === 0 ? (
            <p className="text-sm text-white/60">No open games right now.</p>
          ) : (
            <div className="space-y-2.5">
              {availableGames.map((game) => (
                <div
                  key={game.id}
                  className="flex items-center justify-between rounded-xl bg-[#08142f]/80 p-3 border border-[#00e5ff]/20 hover:border-[#00e5ff]/40 transition-colors"
                >
                  <div>
                    <p className="text-sm font-semibold">Game #{game.id}</p>
                    <p className="text-xs text-white/60">
                      Host: {game.hostName || "Player"} · Bet:{" "}
                      <span className="text-yellow-300">{Number(game.betAmount).toFixed(2)}</span> · Timer:{" "}
                      {Number(game.timerSeconds || 60)}s
                    </p>
                  </div>
                  <button
                    onClick={() => joinGame(game.id)}
                    disabled={loading || joiningId === game.id}
                    className="px-4 py-1.5 rounded-lg bg-[#00e5ff] text-[#001933] hover:bg-[#49eeff] text-sm font-bold disabled:bg-[#246874] disabled:text-white/60 transition-colors"
                  >
                    {joiningId === game.id ? "Joining..." : "Join"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <Footer />
    </div>
  );
}
