"use client";
import { useEffect, useState } from "react";

export default function RecentGames() {
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  const loadGames = async (pageNumber = 1) => {
    setLoading(true);
    try {
      const response = await fetch("/api/get-recent-games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page: pageNumber, limit: 10 }),
      });
      const data = await response.json();
      if (data.games.length < 10) {
        setHasMore(false);
      }
      if (pageNumber === 1) {
        setGames(data.games);
      } else {
        setGames(prev => [...prev, ...data.games]);
      }
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadGames();
  }, []);

  const handleLoadMore = () => {
    const nextPage = page + 1;
    setPage(nextPage);
    loadGames(nextPage);
  };

  return (
    <div>
      {loading && page === 1 ? (
        <div className="text-[#FFD700] text-center">Chargement...</div>
      ) : (
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="text-lg text-[#FFD700] border-b border-[#FFD700]">
              <th className="px-4 py-3">Utilisateur</th>
              <th className="px-4 py-3">Jeu</th>
              <th className="px-4 py-3">Mise</th>
              <th className="px-4 py-3">Gain</th>
              <th className="px-4 py-3">Date</th>
            </tr>
          </thead>
          <tbody>
            {games.map((game, index) => (
              <tr
                key={index}
                className={`border-b border-[#FFD700]/20 ${
                  index % 2 === 0 ? "bg-[#003366]" : "bg-[#004080]"
                } hover:bg-[#FFD700]/10 transition-colors`}
              >
                <td className="px-4 py-4">{game.username}</td>
                <td className="px-4 py-4">{game.gameType}</td>
                <td className="px-4 py-4">{game.betAmount}€</td>
                <td className="px-4 py-4">{game.payout}€</td>
                <td className="px-4 py-4">{new Date(game.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Load More Button */}
      {hasMore && (
        <div className="flex justify-center mt-6">
          <button
            onClick={handleLoadMore}
            className="bg-[#FFD700] text-[#003366] px-6 py-3 rounded-lg font-bold hover:bg-[#FFD700]/80 transition-colors"
          >
            Charger Plus
          </button>
        </div>
      )}
    </div>
  );
}
