"use client";
import React, { useState, useEffect } from "react";
import NavigationBar from "../../components/navigation-bar";
import { useUser } from "@clerk/nextjs";
import { motion, AnimatePresence } from "framer-motion";

function MainComponent() {
  const [stats, setStats] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showTop100, setShowTop100] = useState(false);
  const { user } = useUser();

  const loadStats = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/get-user-stats");
      if (!response.ok) throw new Error(`Error fetching stats: ${response.status}`);
      const data = await response.json();
      setStats(data.users || []);
    } catch (err) {
      console.error(err);
      setError("Impossible de charger les données du classement");
    }
    setLoading(false);
  };

  useEffect(() => {
    loadStats();
    const interval = setInterval(loadStats, 300000);
    return () => clearInterval(interval);
  }, [user?.id]);

  if (error) {
    return (
      <div className="min-h-screen bg-[#003366]">
        <NavigationBar currentPath="/rankings" />
        <div className="flex min-h-screen items-center justify-center">
          <div className="rounded-lg bg-[#FFD700] px-6 py-3 text-[#003366] hover:bg-[#FFD700]/80">
            {error}
          </div>
        </div>
      </div>
    );
  }

  const displayedStats = showTop100 ? stats.slice(0, 100) : stats.slice(0, 10);

  const getMedal = (rank) => {
    if (rank === 1)
      return <span className="text-4xl">🥇</span>;
    if (rank === 2)
      return <span className="text-3xl">🥈</span>;
    if (rank === 3)
      return <span className="text-3xl">🥉</span>;
    return <span className="text-[#FFD700] font-bold">{rank}</span>;
  };

  return (
    <div className="min-h-screen bg-[#003366] text-gray-300">
      <NavigationBar currentPath="/rankings" />
      <div className="flex flex-col items-center px-6 py-24">
        <h1 className="mb-6 text-center text-4xl font-bold text-[#FFD700] drop-shadow-[0_0_10px_rgba(255,215,0,0.5)]">
          Classement des Meilleurs Parieurs
        </h1>

        {/* Toggle Button */}
        <div className="mb-6">
          <button
            onClick={() => setShowTop100(!showTop100)}
            className="rounded-lg bg-[#FFD700] px-6 py-3 text-lg font-semibold text-[#003366] transition-all hover:bg-[#e6c200] hover:scale-105 shadow-lg"
          >
            {showTop100 ? "Afficher le Top 10" : "Afficher le Top 100"}
          </button>
        </div>

        <div className="w-full max-w-5xl rounded-lg border border-[#FFD700] bg-[#003366] p-6 shadow-lg overflow-hidden">
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="text-[#FFD700]">Chargement...</div>
            </div>
          ) : (
            <AnimatePresence mode="wait">
              <motion.table
                key={showTop100 ? "top100" : "top10"}
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.4, ease: "easeInOut" }}
                className="w-full border-collapse text-left shadow-[0_0_20px_rgba(255,215,0,0.15)]"
              >
                <thead>
                  <tr className="border-b border-[#FFD700] text-lg text-[#FFD700]">
                    <th className="px-4 py-3">Rang</th>
                    <th className="px-4 py-3">Utilisateur</th>
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
                        key={player.rank}
                        initial={{ opacity: 0, y: 15 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.25, delay: player.rank * 0.01 }}
                        className={`border-b border-[#FFD700]/20 ${
                          isTop3
                            ? "bg-[#FFD700]/10 hover:bg-[#FFD700]/20"
                            : player.rank % 2 === 0
                            ? "bg-[#004080]"
                            : "bg-[#003366]"
                        } ${isTop3 ? "shadow-[0_0_25px_rgba(255,215,0,0.3)]" : ""} transition-all`}
                      >
                        <td className="px-4 py-4 font-bold text-center">{getMedal(player.rank)}</td>
                        <td className="px-4 py-4 font-semibold text-gray-100">
                          {player.name}
                        </td>
                        <td className="px-4 py-4 text-green-400 font-semibold">
                          {player.gamesWon}
                        </td>
                        <td className="px-4 py-4 text-red-400 font-semibold">
                          {player.gamesLost}
                        </td>
                        <td className="px-4 py-4 text-[#FFD700] font-semibold">
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
