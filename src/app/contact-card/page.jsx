"use client";
import React from "react";
import NavigationBar from "../../components/navigation-bar";

function MainComponent() {
  const [stats, setStats] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const { data: user } = useUser();

  const loadStats = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/get-user-stats", {
        method: "POST",
      });
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

  const updateStats = async () => {
    if (!user?.id) return;
    try {
      await fetch("/api/update-user-stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id }),
      });
      await loadStats();
    } catch (err) {
      console.error(err);
      setError("Unable to update stats");
    }
  };

  useEffect(() => {
    loadStats();
    updateStats();

    const interval = setInterval(() => {
      updateStats();
      loadStats();
    }, 300000);

    return () => clearInterval(interval);
  }, [user?.id]);

  if (error) {
    return (
      <div className="min-h-screen bg-[#003366]">
        <NavigationBar currentPath="/contact-card" />
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

        <div className="w-full max-w-3xl rounded-lg border border-[#FFD700] bg-[#003366] p-6 shadow-lg">
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
                </tr>
              </thead>
              <tbody>
                {stats.map((player, index) => (
                  <tr
                    key={player.user_id}
                    className={`border-b border-[#FFD700]/20 ${
                      index % 2 === 0 ? "bg-[#003366]" : "bg-[#004080]"
                    } hover:bg-[#FFD700]/10 transition-colors`}
                  >
                    <td className="px-4 py-4 font-bold text-[#FFD700]">
                      {index + 1}
                    </td>
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
                    <td className="px-4 py-4 font-semibold text-[#FFD700]">
                      {player.total_won}€
                    </td>
                    <td className="px-4 py-4 text-gray-300">
                      {player.total_bets}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

export default MainComponent;