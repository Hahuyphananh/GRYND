"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { usePostHog } from "posthog-js/react";
import { useSocket } from "../../../context/SocketProvider";
import NavigationBar from "../../../components/navigation-bar";
import Footer from "../../../components/Footer";
import { useTranslation } from "../../../hooks/useTranslation";

export default function DotsAndBoxesLobbyPage() {
  const { isSignedIn, user } = useUser();
  const { socket } = useSocket();
  const router = useRouter();
  const posthog = usePostHog();
  const { t } = useTranslation();

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
    const res = await fetch("/api/dots-and-boxes/available-games", {
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
    const roomId = "lobby:dots-and-boxes";
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
      alert(t("games.dots_and_boxes.invalid_bet_alert"));
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/dots-and-boxes/create-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ betAmount }),
      });
      const data = await res.json();

      if (!res.ok) {
        alert(data.error || t("games.dots_and_boxes.unable_to_create_alert"));
        return;
      }

      socket?.emit("room_event", {
        roomId: "lobby:dots-and-boxes",
        event: "lobby:updated",
      });
      router.push(`/casino/dots-and-boxes/game/${data.gameId}`);
      posthog?.capture("dots_and_boxes_game_started", {
        mode: "create",
        bet_amount: betAmount,
        game_id: data.gameId,
      });
    } finally {
      setLoading(false);
    }
  };

  const joinGame = async (gameId?: number) => {
    setLoading(true);
    if (gameId) setJoiningId(gameId);

    try {
      const res = await fetch("/api/dots-and-boxes/join-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(gameId ? { gameId } : { quickJoin: true }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        alert(data.error || t("games.dots_and_boxes.unable_to_join_alert"));
        return;
      }

      socket?.emit("room_event", {
        roomId: "lobby:dots-and-boxes",
        event: "lobby:updated",
      });
      router.push(`/casino/dots-and-boxes/game/${data.gameId}`);
      posthog?.capture("dots_and_boxes_game_started", {
        mode: gameId ? "join" : "quick_join",
        game_id: data.gameId,
      });
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
  bg-gradient-to-r from-orange-400 via-amber-400 to-yellow-500
  drop-shadow-[0_0_18px_rgba(251,191,36,0.6)] tracking-wide"
          >
            {t("games.dots_and_boxes_name")}
          </h1>
        </motion.div>
        <p className="text-center text-sm text-white/60 mb-7 max-w-xl mx-auto">
          {t("games.dots_and_boxes.lobby_subtitle")}
        </p>

        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-[#0b224f]/70 backdrop-blur-xl 
border border-[#f59e0b]/20 
shadow-[0_0_40px_rgba(245,158,11,0.15)] rounded-2xl p-6 shadow-[0_0_28px_rgba(245,158,11,0.2)]"
        >
          <div className="text-center mb-4 text-sm">
            <span className="uppercase tracking-wider text-[11px] text-white/50 mr-2">
              {t("games.dots_and_boxes.balance_label")}
            </span>
            <span className="font-bold text-transparent bg-clip-text bg-gradient-to-r from-yellow-300 to-yellow-500 text-base">
              {balance.toFixed(2)}
            </span>{" "}
            <span className="text-white/50">{t("games.dots_and_boxes.tokens_suffix")}</span>
          </div>

          <div className="grid md:grid-cols-3 gap-3 items-end">
            <div className="md:col-span-1">
              <label className="text-[11px] uppercase tracking-wider text-white/60">
                {t("games.dots_and_boxes.bet_input_label")}
              </label>
              <input
                type="number"
                value={betAmount}
                min={1}
                max={balance}
                onChange={(e) => setBetAmount(Number(e.target.value))}
                className="w-full mt-1 p-2.5 rounded-lg text-sm
bg-[#020617] border border-[#f59e0b]/30
focus:border-[#f59e0b] focus:ring-0
outline-none text-white"
              />
            </div>
            <button
              onClick={createGame}
              disabled={loading}
              className="p-2.5 rounded-xl text-sm font-bold text-black
bg-gradient-to-r from-amber-200 to-amber-600
hover:scale-105 active:scale-95
transition-all duration-150
shadow-[0_0_18px_rgba(251,191,36,0.6)] disabled:opacity-50 disabled:hover:scale-100"
            >
              {loading ? t("games.dots_and_boxes.creating") : t("games.dots_and_boxes.create_button")}
            </button>
            <button
              onClick={() => joinGame()}
              disabled={loading}
              className="p-2.5 rounded-xl text-sm font-bold text-[#001933]
bg-gradient-to-r from-orange-400 to-amber-500
hover:scale-105 active:scale-95
transition-all duration-150
shadow-[0_0_18px_rgba(251,191,36,0.6)] disabled:opacity-50 disabled:hover:scale-100"
            >
              {loading ? t("games.dots_and_boxes.joining") : t("games.dots_and_boxes.quick_join_button")}
            </button>
          </div>

          <p className="mt-4 text-center text-xs text-white/40">
            {t("games.dots_and_boxes.lobby_tagline")}
          </p>
        </motion.div>

        <div className="mt-6 bg-[#0b224f]/85 border border-[#f59e0b]/30 rounded-2xl p-5 shadow-[0_0_22px_rgba(245,158,11,0.15)]">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-[#FFD700] flex items-center gap-2 uppercase tracking-wider">
              <span aria-hidden>📐</span>
              <span>{t("games.dots_and_boxes.open_challenges_title")}</span>
            </h2>
            <button
              onClick={fetchGames}
              className="px-3 py-1.5 rounded-lg bg-[#f59e0b] text-[#001933] hover:bg-[#fbbf24] text-xs font-semibold shadow-[0_0_10px_rgba(245,158,11,0.35)] transition-colors"
            >
              {t("games.dots_and_boxes.refresh_button")}
            </button>
          </div>

          {availableGames.length === 0 ? (
            <p className="text-sm text-white/60">{t("games.dots_and_boxes.no_open_games")}</p>
          ) : (
            <div className="space-y-2.5">
              {availableGames.map((game) => (
                <div
                  key={game.id}
                  className="flex items-center justify-between rounded-xl bg-[#08142f]/80 p-3 border border-[#f59e0b]/20 hover:border-[#f59e0b]/40 transition-colors"
                >
                  <div>
                    <p className="text-sm font-semibold">
                      {t("games.dots_and_boxes.game_row_label", { gameId: game.id })}
                    </p>
                    <p className="text-xs text-white/60">
                      {t("games.dots_and_boxes.host_field")}: {game.hostName || t("games.dots_and_boxes.host_fallback")} · {t("games.dots_and_boxes.bet_field")}:{" "}
                      <span className="text-yellow-300">
                        {Number(game.betAmount).toFixed(2)}
                      </span>
                    </p>
                  </div>
                  <button
                    onClick={() => joinGame(game.id)}
                    disabled={loading || joiningId === game.id}
                    className="px-4 py-1.5 rounded-lg bg-[#f59e0b] text-[#001933] hover:bg-[#fbbf24] text-sm font-bold disabled:bg-[#7c5a16] disabled:text-white/60 transition-colors"
                  >
                    {joiningId === game.id ? t("games.dots_and_boxes.joining") : t("games.dots_and_boxes.join_button")}
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
