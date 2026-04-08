"use client";
import React, { useMemo, useState, useEffect } from "react";
import NavigationBar from "../../components/navigation-bar";
import { useUser } from "@clerk/nextjs";
import { motion, AnimatePresence } from "framer-motion";

function MainComponent() {
  const [stats, setStats] = useState([]);
  const [gameStats, setGameStats] = useState({});
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showTop100, setShowTop100] = useState(false);
  const [selectedLeaderboard, setSelectedLeaderboard] = useState("overall");
  const { user } = useUser();

  const loadStats = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/get-user-stats");
      if (!response.ok) throw new Error(`Error fetching stats: ${response.status}`);
      const data = await response.json();
      setStats(data.users || []);
      setGameStats(data.games || {});
    } catch (err) {
      console.error(err);
      setError("Impossible de charger les données du classement");
    }
    setLoading(false);
  };

  useEffect(() => {
    const queryGame = new URLSearchParams(window.location.search).get("game");
    if (queryGame) {
      setSelectedLeaderboard(queryGame);
    }
  }, []);

  useEffect(() => {
    loadStats();
    const interval = setInterval(loadStats, 300000);
    return () => clearInterval(interval);
  }, [user?.id]);

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-[#030817] via-[#081a3d] to-[#003b8e]">
        <NavigationBar currentPath="/rankings" />
        <div className="flex min-h-screen items-center justify-center">
          <div className="rounded-lg border border-[#00e5ff]/50 bg-[#00e5ff]/20 px-6 py-3 text-[#d8fbff] hover:bg-[#00e5ff]/35">
            {error}
          </div>
        </div>
      </div>
    );
  }

  const displayedStats =
    selectedLeaderboard === "overall"
      ? showTop100
        ? stats.slice(0, 100)
        : stats.slice(0, 10)
      : showTop100
      ? (gameStats[selectedLeaderboard]?.players || []).slice(0, 100)
      : (gameStats[selectedLeaderboard]?.players || []).slice(0, 10);

  const gameButtons = useMemo(() => Object.entries(gameStats), [gameStats]);

  const getMedal = (rank) => {
    if (rank === 1)
      return <span className="text-4xl">🥇</span>;
    if (rank === 2)
      return <span className="text-3xl">🥈</span>;
    if (rank === 3)
      return <span className="text-3xl">🥉</span>;
    return <span className="font-bold text-[#00e5ff]">{rank}</span>;
  };

  const formatAmount = (value) => Number(value || 0).toFixed(2);

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#030817] via-[#081a3d] to-[#003b8e] text-[#c9f7ff]">
      <NavigationBar currentPath="/rankings" />
      <div className="flex flex-col items-center px-6 py-24">
        <h1 className="mb-6 text-center text-4xl font-bold text-[#f5ff3b] drop-shadow-[0_0_10px_rgba(245,255,59,0.5)]">
          Classement des Meilleurs Parieurs
        </h1>

        {/* Toggle Button */}
        <div className="mb-6 flex flex-wrap justify-center gap-3">
          <button
            onClick={() => setShowTop100(!showTop100)}
            className="rounded-lg border border-[#f5ff3b]/50 bg-[#f5ff3b] px-6 py-3 text-lg font-semibold text-[#041125] transition-all hover:brightness-95 hover:scale-105 shadow-[0_0_18px_rgba(245,255,59,0.4)]"
          >
            {showTop100 ? "Afficher le Top 10" : "Afficher le Top 100"}
          </button>
        </div>

        <div className="mb-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => setSelectedLeaderboard("overall")}
            className={`rounded-md px-4 py-2 text-sm font-semibold transition-all ${
              selectedLeaderboard === "overall"
                ? "bg-[#f5ff3b] text-[#06152c]"
                : "bg-[#0a214d] text-[#00e5ff] hover:bg-[#123b82]"
            }`}
          >
            Global
          </button>
          {gameButtons.map(([gameKey, data]) => (
            <button
              key={gameKey}
              onClick={() => setSelectedLeaderboard(gameKey)}
              className={`rounded-md px-4 py-2 text-sm font-semibold transition-all ${
                selectedLeaderboard === gameKey
                  ? "bg-[#f5ff3b] text-[#06152c]"
                  : "bg-[#0a214d] text-[#00e5ff] hover:bg-[#123b82]"
              }`}
            >
              {data.gameLabel}
            </button>
          ))}
        </div>

        <div className="w-full max-w-7xl overflow-hidden rounded-lg border border-[#00e5ff]/50 bg-[#08142f]/95 p-6 shadow-[0_0_28px_rgba(0,229,255,0.2)]">
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="text-[#00e5ff]">Chargement...</div>
            </div>
          ) : (
            <AnimatePresence mode="wait">
              <motion.table
                key={`${selectedLeaderboard}-${showTop100 ? "top100" : "top10"}`}
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.4, ease: "easeInOut" }}
                className="w-full border-collapse text-left shadow-[0_0_20px_rgba(0,229,255,0.2)]"
              >
                <thead>
                  <tr className="border-b border-[#00e5ff]/50 text-sm text-[#f5ff3b] md:text-base">
                    <th className="px-4 py-3">Rang</th>
                    <th className="px-4 py-3">Utilisateur</th>
                    <th className="px-4 py-3">Montant Gagné</th>
                    <th className="px-4 py-3">Montant Perdu</th>
                    <th className="px-4 py-3">Profit Total</th>
                    <th className="px-4 py-3">Parties Gagnées</th>
                    <th className="px-4 py-3">Parties Perdues</th>
                    <th className="px-4 py-3">Net Games</th>
                    <th className="px-4 py-3">Win Rate (%)</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedStats.map((player) => {
                    const totalGames = player.gamesWon + player.gamesLost;
                    const winRate =
                      totalGames > 0
                        ? ((player.gamesWon / totalGames) * 100).toFixed(1)
                        : "0.0";

                    const isTop3 = player.rank <= 3;

                    return (
                      <motion.tr
                        key={`${selectedLeaderboard}-${player.rank}-${player.name}`}
                        initial={{ opacity: 0, y: 15 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.25, delay: player.rank * 0.01 }}
                        className={`border-b border-[#00e5ff]/20 ${
                          isTop3
                            ? "bg-[#f5ff3b]/10 hover:bg-[#f5ff3b]/20"
                            : player.rank % 2 === 0
                            ? "bg-[#0b224f]"
                            : "bg-[#08142f]"
                        } ${isTop3 ? "shadow-[0_0_25px_rgba(245,255,59,0.25)]" : ""} transition-all`}
                      >
                        <td className="px-4 py-4 font-bold text-center">{getMedal(player.rank)}</td>
                        <td className="px-4 py-4 font-semibold text-gray-100">
                          {player.name}
                        </td>
                        <td className="px-4 py-4 text-green-400 font-semibold">
                          {formatAmount(player.amountWon)}
                        </td>
                        <td className="px-4 py-4 text-red-400 font-semibold">
                          {formatAmount(player.amountLost)}
                        </td>
                        <td
                          className={`px-4 py-4 font-semibold ${
                            Number(player.totalProfit) >= 0 ? "text-green-400" : "text-red-400"
                          }`}
                        >
                          {Number(player.totalProfit) >= 0 ? "+" : ""}
                          {formatAmount(player.totalProfit)}
                        </td>
                        <td className="px-4 py-4 text-green-400 font-semibold">
                          {player.gamesWon}
                        </td>
                        <td className="px-4 py-4 text-red-400 font-semibold">
                          {player.gamesLost}
                        </td>
                        <td className="px-4 py-4 font-semibold text-[#00e5ff]">
                          {player.netGames}
                        </td>
                        <td className="px-4 py-4 text-green-400 font-semibold">
                          {winRate}%
                        </td>
                      </motion.tr>
                    );
                  })}
                </tbody>
              </motion.table>
            </AnimatePresence>
          )}
        </div>
      </div>
    </div>
  );
}

export default MainComponent;
