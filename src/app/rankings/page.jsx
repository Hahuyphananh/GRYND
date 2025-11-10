"use client";
import React, { useState, useEffect } from "react";
import NavigationBar from "../../components/navigation-bar";
import { useUser } from "@clerk/nextjs";

function MainComponent() {
  const [stats, setStats] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const { user } = useUser();

  const loadStats = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/get-user-stats");
      if (!response.ok) {
        throw new Error(`Error fetching stats: ${response.status}`);
      }
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
                  <th className="px-4 py-3">Parties Gagnées</th>
                  <th className="px-4 py-3">Parties Perdues</th>
                  <th className="px-4 py-3">Net Games</th>
                  <th className="px-4 py-3">Win Rate (%)</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((player) => {
                  const totalGames = player.gamesWon + player.gamesLost;
                  const winRate =
                    totalGames > 0
                      ? ((player.gamesWon / totalGames) * 100).toFixed(1)
                      : "0.0";

                  return (
                    <tr
                      key={player.rank}
                      className={`border-b border-[#FFD700]/20 ${
                        player.rank % 2 === 0 ? "bg-[#004080]" : "bg-[#003366]"
                      } hover:bg-[#FFD700]/10 transition-colors`}
                    >
                      <td className="px-4 py-4 font-bold text-[#FFD700]">
                        {player.rank}
                      </td>
                      <td className="px-4 py-4 text-gray-300">{player.name}</td>
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
