"use client";
import React from "react";



export default function Index() {
  return (function MainComponent() {
  const [search, setSearch] = useState("");
  const [player, setPlayer] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const searchPlayer = useCallback(async (searchTerm) => {
    setLoading(true);
    setError(null);
    setPlayer(null);

    try {
      const response = await fetch("/api/search-player", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ search: searchTerm }),
      });

      if (!response.ok) {
        throw new Error("Failed to fetch player data");
      }

      const data = await response.json();
      setPlayer(data);
    } catch (err) {
      setError("Failed to search for player");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (search) {
        searchPlayer(search);
      }
    }, 2000);

    return () => clearTimeout(timeoutId);
  }, [search, searchPlayer]);

  return (
    <div className="max-w-2xl mx-auto p-4 w-full">
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search for a player..."
        className="w-full px-4 py-2 rounded-lg border border-[#FFD700] mb-4 focus:outline-none focus:border-[#FFD700] bg-[#0A192F] text-white placeholder-gray-400"
      />

      {loading && (
        <div className="animate-pulse space-y-4">
          <div className="h-64 bg-[#FFD700]/20 rounded-lg"></div>
          <div className="h-8 bg-[#FFD700]/20 rounded w-3/4"></div>
          <div className="h-4 bg-[#FFD700]/20 rounded w-1/2"></div>
        </div>
      )}

      {error && (
        <div className="text-red-500 text-center py-4">
          {error}
        </div>
      )}

      {!loading && !player && search && (
        <div className="text-center py-4 text-[#FFD700]">
          No player found
        </div>
      )}

      {player && (
        <div className="bg-[#0A192F] rounded-lg overflow-hidden border border-[#FFD700] transition-all duration-300 hover:border-[#FFD700] hover:shadow-lg hover:shadow-[#FFD700]/20">
          {player.thumb && (
            <img
              src={player.thumb}
              alt={`${player.name} profile`}
              className="w-full h-64 object-cover"
            />
          )}

          <div className="p-4">
            <h2 className="text-2xl font-bold text-[#FFD700] mb-2">
              {player.name}
            </h2>

            <div className="flex flex-wrap gap-2 mb-4">
              {player.team && (
                <span className="text-sm text-white hover:text-[#FFD700] transition-colors">
                  🏃 {player.team}
                </span>
              )}
              {player.position && (
                <span className="text-sm text-white hover:text-[#FFD700] transition-colors">
                  📍 {player.position}
                </span>
              )}
              {player.nationality && (
                <span className="text-sm text-white hover:text-[#FFD700] transition-colors">
                  🌍 {player.nationality}
                </span>
              )}
            </div>

            <div className="flex gap-4 mb-4">
              {player.height && (
                <span className="text-sm text-white hover:text-[#FFD700] transition-colors">
                  Height: {player.height}
                </span>
              )}
              {player.weight && (
                <span className="text-sm text-white hover:text-[#FFD700] transition-colors">
                  Weight: {player.weight}
                </span>
              )}
            </div>

            <div className="flex gap-4 mb-4">
              {player.facebook && (
                <a
                  href={player.facebook}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#FFD700] hover:text-[#FFD700]/80 transition-colors"
                >
                  <i className="fab fa-facebook-f"></i>
                </a>
              )}
              {player.twitter && (
                <a
                  href={player.twitter}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#FFD700] hover:text-[#FFD700]/80 transition-colors"
                >
                  <i className="fab fa-twitter"></i>
                </a>
              )}
              {player.instagram && (
                <a
                  href={player.instagram}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#FFD700] hover:text-[#FFD700]/80 transition-colors"
                >
                  <i className="fab fa-instagram"></i>
                </a>
              )}
            </div>

            {player.description && (
              <details className="mt-4">
                <summary className="cursor-pointer text-[#FFD700] font-medium hover:text-[#FFD700]/80 transition-colors">
                  Player Description
                </summary>
                <p className="mt-2 text-sm text-white hover:text-[#FFD700] transition-colors">
                  {player.description}
                </p>
              </details>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StoryComponent() {
  return (
    <div className="min-h-screen bg-[#0A192F] py-8">
      <MainComponent />
    </div>
  );
});
}