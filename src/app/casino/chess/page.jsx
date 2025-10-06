"use client";
import { useRouter } from "next/navigation";
import NavigationBar from "../../../components/navigation-bar";

export default function ChessLobby() {
  const router = useRouter();
  const tables = [1, 5, 10, 20, 50, 100];

  // Function to start an AI game
  async function handleAIGame() {
    try {
      const res = await fetch("/api/chess/create-ai-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ai_game: true,
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to create AI game");
      }

      const data = await res.json();

      // Redirect to the AI page (you can include gameId if you need it later)
      router.push(`/casino/chess/ai?gameId=${data.gameId}`);
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
        <button
          onClick={handleAIGame}
          className="bg-green-500 text-white px-6 py-4 rounded-lg text-xl font-semibold hover:bg-green-400"
        >
          Play vs AI 🤖
        </button>
      </div>
    </div>
  );
}
