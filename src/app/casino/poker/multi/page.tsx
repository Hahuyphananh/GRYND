"use client";
import React, { useState } from "react";
import NavigationBar from "../../../../components/navigation-bar";

export default function PokerMultiPage() {
  const [loading, setLoading] = useState(false);
  const [game, setGame] = useState<any>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [buyIn, setBuyIn] = useState(10);
  const [firstRoundComplete, setFirstRoundComplete] = useState(false);


  const handleJoinGame = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/initialize-poker-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ numPlayers: 3, buyIn }),
      });
      if (!res.ok) {
        const error = await res.json();
        alert(error.error || "Erreur lors de la création de la partie.");
        return;
      }
      const data = await res.json();
      setGame(data);
    } catch (err) {
      console.error("❌ Error joining game:", err);
      alert("Erreur serveur.");
    } finally {
      setLoading(false);
    }
  };

  // 👇 NEW: handle player folding
  const handlePlayerFold = async () => {
    if (!game) return;
    setActionLoading(true);
    try {
      const res = await fetch("/api/poker/multi/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: game.gameId, action: "fold" }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Erreur lors de l’action.");
        return;
      }
      setGame(data);

      // Optionally, trigger AI turn if next player is AI
      const nextPlayer = data.players.find((p: any) => p.isTurn);
      if (nextPlayer?.isAI) {
        setTimeout(() => handleAITurn(nextPlayer.id), 800);
      }
    } catch (err) {
      console.error("❌ Fold error:", err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleEndHand = async () => {
    if (!game) return;
    setActionLoading(true);

    try {
      const res = await fetch("/api/poker/multi/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: game.gameId }),
      });

      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Erreur lors de la fin de la main.");
        return;
      }

      alert(
        `${data.winner.isAI ? `AI` : "You"} won the hand! 🏆\nPot awarded: ${data.potAwarded} tokens`
      );

      // Refresh with updated game state
      setGame(data.updatedGame);
    } catch (err) {
      console.error("❌ End hand error:", err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleAction = async (action: string, amount = 0) => {
  if (!game) return;
  setActionLoading(true);
  try {
    const res = await fetch("/api/poker/multi/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId: game.gameId, action, amount }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "Erreur lors de l’action.");
      return;
    }
    setGame(data);

    // ✅ Check if first round is complete
if (!firstRoundComplete) {
  const allActiveActed = data.players
    .filter((p: any) => !p.has_folded)
    .every((p: any) => p.lastAction !== null && p.lastAction !== undefined);
  if (allActiveActed) setFirstRoundComplete(true);
}

    const remainingPlayers = data.players.filter((p: any) => !p.has_folded);
    if (remainingPlayers.length <= 1) {
      await handleEndHand();
      return;
    }

    // ✅ Trigger only the next AI
    const nextPlayer = data.players.find((p: any) => p.isTurn);
    if (nextPlayer?.isAI) {
      setTimeout(() => handleAITurn(nextPlayer.id), 800);
    }
  } catch (err) {
    console.error("❌ Action error:", err);
  } finally {
    setActionLoading(false);
  }
};


  const handleAITurn = async (aiId: string) => {
  if (!game) return;
  setActionLoading(true);
  try {
    const res = await fetch("/api/poker/multi/ai-turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId: game.gameId, aiId }),
    });
    const aiData = await res.json();
    if (!res.ok) {
      console.error(aiData.error || "AI turn error.");
      return;
    }
    setGame(aiData);

    if (!firstRoundComplete) {
  const allActiveActed = aiData.players
    .filter((p: any) => !p.has_folded)
    .every((p: any) => p.lastAction !== null && p.lastAction !== undefined);
  if (allActiveActed) setFirstRoundComplete(true);
}

    const remainingPlayers = aiData.players.filter((p: any) => !p.has_folded);
    if (remainingPlayers.length <= 1) {
      await handleEndHand();
      return;
    }

    // ✅ Only trigger the next AI turn
    const nextPlayer = aiData.players.find((p: any) => p.isTurn);
    if (nextPlayer?.isAI) {
      setTimeout(() => handleAITurn(nextPlayer.id), 800);
    }
  } catch (err) {
    console.error("❌ AI turn error:", err);
  } finally {
    setActionLoading(false);
  }
};

// --- Poker card renderer ---
const renderCard = (card: any, i: number, size = "h-20 w-14 md:h-32 md:w-24") => {
  const suitSymbols: Record<string, string> = { hearts: "♥", diamonds: "♦", clubs: "♣", spades: "♠" };
  const symbol = suitSymbols[card.suit] || card.suit;
  return (
    <div
      key={i}
      className={`${size} bg-white text-xl flex items-center justify-center rounded shadow`}
      style={{
        color: ["♥", "♦"].includes(symbol) ? "red" : "black",
        boxShadow: "none",
      }}
    >
      {card.value}
      {symbol}
    </div>
  );
};


  return (
    <div className="min-h-screen bg-[#003366] pt-20">
      <NavigationBar currentPath="/casino" />
      <div className="mx-auto max-w-4xl px-4 py-8 text-center">
        <h1 className="text-4xl font-bold text-[#FFD700] mb-6">
          ♠️ Poker — You vs AI
        </h1>

        {!game ? (
          <>
            <p className="text-lg text-[#FFD700] mb-6">
              Bienvenue au mode Poker! Cliquez ci-dessous pour commencer.
            </p>

            <div className="flex items-center justify-center gap-3 mb-4">
              <label className="text-[#FFD700] font-semibold">Buy-in:</label>
              <input
                type="number"
                min={20}
                max={2000}
                value={buyIn}
                onChange={(e) => setBuyIn(parseInt(e.target.value || "0", 10))}
                className="w-28 px-3 py-2 rounded text-black"
              />
              <span className="text-[#FFD700]">tokens</span>
            </div>

            <button
              onClick={handleJoinGame}
              disabled={loading}
              className="bg-yellow-400 hover:bg-yellow-300 text-black px-6 py-3 rounded-full font-bold disabled:opacity-50"
            >
              {loading ? "🔄 Création en cours..." : "🎮 Jouer"}
            </button>
          </>
        ) : (
          <div className="relative bg-green-700 rounded-full shadow-2xl mx-auto w-[800px] h-[500px] flex items-center justify-center border-8 border-yellow-600">

            {/* Pot Info */}
            <div className="absolute top-6 left-1/2 -translate-x-1/2 text-center text-[#FFD700]">
              <h2 className="text-2xl font-bold">
                Pot: {firstRoundComplete ? game.pot : "???"} tokens
              </h2>
              <p className="text-sm opacity-80">Game ID: {game.gameId}</p>
            </div>

   {/* Community Cards */}
<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-2">
  {/* Top row: first 3 cards */}
  <div className="flex gap-2">
    {game?.communityCards?.slice(0, 3).map((c: any, i: number) =>
      renderCard(c, i, "w-12 h-16") // 👈 smaller card size
    )}
  </div>

  {/* Bottom row: last 2 cards */}
  <div className="flex gap-2">
    {game?.communityCards?.slice(3, 5).map((c: any, i: number) =>
      renderCard(c, i + 3, "w-12 h-16") // 👈 smaller card size
    )}
  </div>
</div>



            {/* Player (You) — Left */}
            <div className="absolute left-8 top-1/2 -translate-y-1/2 bg-black/60 p-3 rounded-lg shadow-md text-center w-40">
              <p className="font-bold text-[#FFD700]">You</p>
              <p className="text-sm text-white">
                Bankroll: {game.players[0]?.stack ?? 0} tokens
              </p>
              <p className="text-xs text-gray-300">
                Last Action: {game.players[0]?.lastAction || "—"}
              </p>
              <div className="flex gap-2 justify-center mt-2">
                {game.players[0]?.hand?.map((c: any, i: number) => renderCard(c, i))}
              </div>
            </div>

            {/* AI — Right */}
            <div className="absolute right-8 top-1/2 -translate-y-1/2 bg-black/60 p-3 rounded-lg shadow-md text-center w-40">
              <p className="font-bold text-[#FFD700]">AI</p>
              <p className="text-sm text-white">
                Bankroll: {game.players[1]?.stack ?? 0} tokens
              </p>
              <p className="text-xs text-gray-300">
                Last Action: {game.players[1]?.lastAction || "—"}
              </p>
              <div className="flex gap-2 justify-center mt-2">
                <div className="h-20 w-14 bg-gray-800 rounded shadow flex items-center justify-center text-white text-xl">
                  ?
                </div>
                <div className="h-20 w-14 bg-gray-800 rounded shadow flex items-center justify-center text-white text-xl">
                  ?
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex gap-4">
              <button
                onClick={handlePlayerFold}
                disabled={actionLoading}
                className="bg-red-500 hover:bg-red-400 text-white px-6 py-2 rounded-full font-bold"
              >
                Fold
              </button>
              <button
                onClick={() => handleAction("call")}
                disabled={actionLoading}
                className="bg-green-500 hover:bg-green-400 text-white px-6 py-2 rounded-full font-bold"
              >
                Call
              </button>
              <button
                onClick={() => {
                  const raiseAmount = prompt("Raise by how many tokens?");
                  if (raiseAmount) handleAction("raise", parseInt(raiseAmount, 10));
                }}
                disabled={actionLoading}
                className="bg-blue-500 hover:bg-blue-400 text-white px-6 py-2 rounded-full font-bold"
              >
                Raise
              </button>
              <button
                onClick={handleEndHand}
                disabled={actionLoading}
                className="absolute top-6 right-6 bg-yellow-400 hover:bg-yellow-300 text-black px-4 py-2 rounded-full font-bold"
              >
                End Hand
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

}
