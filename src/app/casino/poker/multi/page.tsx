"use client";

import React, { useState } from "react";
import NavigationBar from "../../../../components/navigation-bar";

export default function PokerMultiPage() {
  const [loading, setLoading] = useState(false);
  const [game, setGame] = useState(null); // store game data after joining

  const handleJoinGame = async () => {
    try {
      setLoading(true);

      const res = await fetch("/api/initialize-poker-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nPlayers: 3 }), // 👈 default 3 players for now
      });

      if (!res.ok) {
        const error = await res.json();
        alert(error.error || "Erreur lors de la création de la partie.");
        return;
      }

      const data = await res.json();
      setGame(data); // set game state instead of redirecting
    } catch (err) {
      console.error("❌ Error joining game:", err);
      alert("Erreur serveur.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#003366] pt-20">
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto max-w-4xl px-4 py-8 text-center">
        <h1 className="text-4xl font-bold text-[#FFD700] mb-6">
          ♣️ Multi-Table Poker (3+ Players)
        </h1>

        {!game ? (
          <>
            <p className="text-lg text-[#FFD700] mb-6">
              Bienvenue au mode multijoueur! Ici, vous pouvez rejoindre une table de 3+ joueurs.
              Si d’autres joueurs ne sont pas disponibles, des IA compléteront la table.
            </p>

            <button
              onClick={handleJoinGame}
              disabled={loading}
              className="bg-yellow-400 hover:bg-yellow-300 text-black px-6 py-3 rounded-full font-bold disabled:opacity-50"
            >
              {loading ? "🔄 Création en cours..." : "🎮 Rejoindre une Table"}
            </button>
          </>
        ) : (
          <div className="text-left text-white">
            <h2 className="text-2xl font-bold mb-4">Table ID: {game.gameId}</h2>
            <p>Pot: {game.pot}</p>
            <p>Minimum Bet: {game.minBet}</p>
            <h3 className="mt-4 font-bold">Players:</h3>
            <ul className="list-disc ml-6">
              {game.players.map((p, idx) => (
                <li key={idx}>
                  {p.isAI ? "🤖 AI" : "🧑 You"} - Stack: {p.stack} - Hand:{" "}
                  {p.hand.map(c => `${c.value}♠️`).join(", ")}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
