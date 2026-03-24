"use client";
import { useRouter } from "next/navigation";
import NavigationBar from "../../../components/navigation-bar";
import { useEffect, useState } from "react";

export default function ChessLobby() {
  const router = useRouter();
  const tables = [1, 5, 10, 20, 50, 100];

  const [showBetPopup, setShowBetPopup] = useState(false);
  const [betAmount, setBetAmount] = useState("");
  const [availableGames, setAvailableGames] = useState([]);
  const [isLoadingAvailableGames, setIsLoadingAvailableGames] = useState(false);
  const [joiningGameId, setJoiningGameId] = useState(null);

  useEffect(() => {
    fetchAvailableGames();
  }, []);

  async function fetchAvailableGames() {
    setIsLoadingAvailableGames(true);
    try {
      const res = await fetch("/api/chess/available-games", { cache: "no-store" });
      const data = await res.json();
      if (data.success) {
        setAvailableGames(data.data.games || []);
      }
    } catch (error) {
      console.error("Failed to load available chess games", error);
    }
    setIsLoadingAvailableGames(false);
  }

  async function joinSpecificGame(gameId) {
    setJoiningGameId(gameId);
    try {
      const res = await fetch("/api/chess/join-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        alert(data.error || "Unable to join game");
        fetchAvailableGames();
        return;
      }

      router.push(`/casino/chess-game/${gameId}?color=black`);
    } catch (error) {
      console.error("Failed to join chess game", error);
      alert("Unable to join game");
    } finally {
      setJoiningGameId(null);
    }
  }

  // This replaces your old handleAIGame
  async function startAIGame() {
    try {
      const res = await fetch("/api/chess/create-ai-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ai_game: true,
          betAmount: Number(betAmount),
        }),
      });

      if (!res.ok) throw new Error("Failed to create AI game");

      const data = await res.json();
      router.push(`/casino/chess/ai?gameId=${data.gameId}&bet=${betAmount}`);
    } catch (error) {
      console.error("Error creating AI game:", error);
    }
  }

  return (
    <div className="min-h-screen bg-[#003366] text-white p-6 text-center">
      <NavigationBar currentPath="/casino" />
      <h1 className="text-4xl font-bold text-[#FFD700] mb-8 mt-12">
        ♟️ Chess Tables
      </h1>

      <div className="flex flex-wrap justify-center gap-4">
        {tables.map((amount) => (
          <button
            key={amount}
            onClick={() => router.push(`/casino/chess/${amount}`)}
            className="bg-[#FFD700] text-[#003366] px-6 py-4 rounded-lg text-xl font-semibold hover:bg-[#FFD700]/80"
          >
            ${amount} Table
          </button>
        ))}

        {/* Instead of instantly starting AI game, open popup */}
        <button
          onClick={() => setShowBetPopup(true)}
          className="bg-green-500 text-white px-6 py-4 rounded-lg text-xl font-semibold hover:bg-green-400"
        >
          Play vs AI 🤖
        </button>
      </div>

      <div className="max-w-3xl mx-auto mt-10 bg-[#002147] p-5 rounded-xl border border-[#FFD700]/40 text-left">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-[#FFD700]">Available Games</h2>
          <button
            onClick={fetchAvailableGames}
            className="bg-[#FFD700] text-[#003366] px-4 py-2 rounded-lg font-semibold hover:bg-[#FFD700]/80"
          >
            {isLoadingAvailableGames ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {availableGames.length === 0 ? (
          <p className="text-white/80">No open games right now. Create one from a table above.</p>
        ) : (
          <div className="space-y-3">
            {availableGames.map((game) => (
              <div key={game.id} className="flex items-center justify-between bg-[#003366] rounded-lg p-3">
                <div>
                  <p className="font-semibold">Game #{game.id}</p>
                  <p className="text-sm text-white/80">
                    Host: {game.hostName || "Player"} · Bet: ${Number(game.betAmount)}
                  </p>
                </div>
                <button
                  onClick={() => joinSpecificGame(game.id)}
                  disabled={joiningGameId === game.id}
                  className="bg-green-600 px-4 py-2 rounded-lg font-bold hover:bg-green-700 disabled:bg-green-800"
                >
                  {joiningGameId === game.id ? "Joining..." : "Join"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* BETTING POPUP MODAL */}
      {showBetPopup && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
          <div className="bg-white text-black p-8 rounded-lg w-96 shadow-lg">
            <h2 className="text-2xl font-bold mb-4 text-center">
              Enter Your Bet Amount
            </h2>

            <input
              type="number"
              min="1"
              value={betAmount}
              onChange={(e) => setBetAmount(e.target.value)}
              className="w-full border px-3 py-2 mb-4 rounded"
              placeholder="Bet amount"
            />

            <div className="flex justify-between">
              <button
                onClick={() => setShowBetPopup(false)}
                className="bg-gray-600 text-white px-4 py-2 rounded hover:bg-gray-700"
              >
                Cancel
              </button>

              <button
                onClick={startAIGame}
                disabled={!betAmount}
                className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 disabled:bg-green-300"
              >
                Start Game
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
