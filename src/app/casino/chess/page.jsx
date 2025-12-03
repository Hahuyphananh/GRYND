"use client";
import { useRouter } from "next/navigation";
import NavigationBar from "../../../components/navigation-bar";
import { useState } from "react";

export default function ChessLobby() {
  const router = useRouter();
  const tables = [1, 5, 10, 20, 50, 100];

  const [showBetPopup, setShowBetPopup] = useState(false);
  const [betAmount, setBetAmount] = useState("");

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
