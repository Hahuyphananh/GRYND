"use client";
import React, { useState, useEffect } from "react";
import NavigationBar from "../../components/navigation-bar";
import { useUser } from "@clerk/nextjs"; // ← (you forgot to import this!)

function MainComponent() {
  const [stats, setStats] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const { data: user } = useUser();

  const loadStats = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/get-user-stats", { method: "POST" });
      if (!response.ok) {
        throw new Error(`Error fetching stats: ${response.status}`);
      }
      const data = await response.json();
      setStats(data.stats);
    } catch (err) {
      console.error(err);
      setError("Unable to load leaderboard data");
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

  return (
    <div className="min-h-screen bg-[#003366] text-gray-300">
      <NavigationBar currentPath="/rankings" />
      <div className="flex flex-col items-center px-6 py-24">
        <h1 className="mb-8 text-center text-4xl font-bold text-[#FFD700]">
          Classement des Meilleurs Parieurs
        </h1>

        <div className="w-full max-w-5xl rounded-lg border border-[#FFD700] bg-[#003366] p-6 shadow-lg">
          {loading ? (
            <div className="flex justify-center py-8">
              <div className="text-[#FFD700]">Chargement...</div>
            </div>
          ) : (
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-[#FFD700] text-lg text-[#FFD700]">
                  <th className="px-4 py-3">Rang</th>
                  <th className="px-4 py-3">Utilisateur</th>
                  <th className="px-4 py-3">Gains</th>
                  <th className="px-4 py-3">Paris Placés</th>
                  <th className="px-4 py-3">Win Rate (%)</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((player, index) => {
                  const totalGames = player.gamesWon + player.gamesLost;
                  const winRate = totalGames > 0 ? ((player.gamesWon / totalGames) * 100).toFixed(1) : "0.0";

                  {/* Recent Games Section */}
<div className="mt-16 w-full max-w-5xl">
  <h2 className="mb-6 text-3xl font-bold text-center text-[#FFD700]">Derniers Paris Joués</h2>

  <div className="rounded-lg border border-[#FFD700] bg-[#003366] p-6 shadow-lg">
    {/* You could fetch this from another endpoint like /api/recent-games */}
    <RecentGames />
  </div>
</div>


                  return (
                    <tr
                      key={player.user_id}
                      className={`border-b border-[#FFD700]/20 ${
                        index % 2 === 0 ? "bg-[#003366]" : "bg-[#004080]"
                      } hover:bg-[#FFD700]/10 transition-colors`}
                    >
                      <td className="px-4 py-4 font-bold text-[#FFD700]">{index + 1}</td>
                      <td className="flex items-center gap-3 px-4 py-4">
                        {player.user_image && (
                          <img
                            src={player.user_image}
                            alt={`Avatar de ${player.username}`}
                            className="h-8 w-8 rounded-full"
                          />
                        )}
                        <span className="text-gray-300">{player.username}</span>
                      </td>
                      <td className="px-4 py-4 font-semibold text-[#FFD700]">{player.total_won}€</td>
                      <td className="px-4 py-4 text-gray-300">{player.total_bets}</td>
                      <td className="px-4 py-4 text-green-400 font-semibold">{winRate}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

export default MainComponent;
