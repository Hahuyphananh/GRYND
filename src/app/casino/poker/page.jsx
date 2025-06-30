"use client";

import React, { useEffect, useState } from "react";

function PokerPage() {
  const [userTokens, setUserTokens] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [game, setGame] = useState(null);
  const [raiseAmount, setRaiseAmount] = useState(0);
  const [result, setResult] = useState(null);
  const [stats, setStats] = useState({ biggestWin: 0, totalHands: 0, totalWins: 0 });
  const [opponentHand, setOpponentHand] = useState([]);
  const [playerHand, setPlayerHand] = useState([]);
  const [pot, setPot] = useState(0);

  useEffect(() => {
    fetchTokens();
  }, []);

  const fetchTokens = async () => {
    try {
      const res = await fetch("/api/get-user-tokens", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setUserTokens(data.data.balance);
      } else {
        throw new Error(data.error || "Erreur inconnue");
      }
    } catch (e) {
      setError("Impossible de charger les tokens.");
    } finally {
      setLoading(false);
    }
  };

  const initializeGame = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/initialize-poker-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ smallBlind: 5, bigBlind: 10, minBuy: 1000 })
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error);
      setGame(data.game);
      setPlayerHand(data.playerHand);
      setOpponentHand(["?", "?"]); // initially hidden
      setPot(data.pot);
      setResult(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleAction = async (action) => {
    if (!game) return;
    setError(null);
    try {
      const res = await fetch("/api/handle-poker-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameId: game.id,
          action,
          amount: action === "raise" ? raiseAmount : null,
        })
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error);

      setPot(data.pot);
      setPlayerHand(data.playerHand);
      setOpponentHand(data.opponentHand);
      setResult(data.result);
      setStats(prev => ({
        biggestWin: Math.max(prev.biggestWin, data.result.winAmount || 0),
        totalHands: prev.totalHands + 1,
        totalWins: data.result.won ? prev.totalWins + 1 : prev.totalWins,
      }));
      setUserTokens(prev => prev + (data.result.winAmount || 0) - (data.result.bet || 0));
      setGame(null);
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#001933] to-[#000d1a] text-white p-8">
      <div className="max-w-4xl mx-auto shadow-lg border border-yellow-400/30 rounded-2xl p-8 bg-[#0a1e3a]">
        <h1 className="text-4xl font-bold text-center text-yellow-400 mb-6">♠️ Poker Royale</h1>
        <p className="text-lg font-semibold">🪙 Tokens: {userTokens}</p>

        {error && <p className="text-red-400 text-center mt-4">{error}</p>}

        {!game && (
          <div className="text-center mt-8">
            <button
              onClick={initializeGame}
              className="bg-yellow-400 hover:bg-yellow-300 text-black px-6 py-3 rounded-full font-bold"
            >
              Nouvelle Partie
            </button>
          </div>
        )}

        {game && (
          <div className="mt-8">
            <div className="flex justify-center gap-4 mb-4">
              <div>
                <h3 className="text-yellow-300 text-center">Votre main</h3>
                <div className="flex gap-2 justify-center mt-2">
                  {playerHand.map((card, i) => (
                    <div
                      key={i}
                      className="w-12 h-16 bg-white text-black flex items-center justify-center rounded shadow"
                    >
                      {card}
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <h3 className="text-yellow-300 text-center">Main AI</h3>
                <div className="flex gap-2 justify-center mt-2">
                  {opponentHand.map((card, i) => (
                    <div
                      key={i}
                      className="w-12 h-16 bg-white text-black flex items-center justify-center rounded shadow"
                    >
                      {card}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="text-center text-yellow-300 font-semibold text-lg mb-2">
              Pot actuel: {pot} tokens
            </div>

            <div className="flex flex-wrap gap-4 justify-center items-center">
              <button
                onClick={() => handleAction("fold")}
                className="bg-red-600 hover:bg-red-700 px-5 py-2 rounded-full font-bold"
              >
                Fold
              </button>
              <button
                onClick={() => handleAction("call")}
                className="bg-blue-600 hover:bg-blue-700 px-5 py-2 rounded-full font-bold"
              >
                Call
              </button>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={raiseAmount}
                  onChange={(e) => setRaiseAmount(Number(e.target.value))}
                  className="w-24 px-2 py-1 rounded text-black"
                />
                <button
                  onClick={() => handleAction("raise")}
                  className="bg-green-600 hover:bg-green-700 px-4 py-2 rounded-full font-bold"
                >
                  Raise
                </button>
              </div>
            </div>
          </div>
        )}

        {result && (
          <div className="mt-6 text-center">
            <p className="text-xl font-bold">
              {result.message} {result.won && `+${result.winAmount} tokens! 🎉`}
            </p>
          </div>
        )}

        <div className="mt-10 grid grid-cols-3 gap-6 text-white text-center">
          <div>
            <p className="font-semibold text-yellow-300">Plus gros gain</p>
            <p>{stats.biggestWin} tokens</p>
          </div>
          <div>
            <p className="font-semibold text-yellow-300">Mains jouées</p>
            <p>{stats.totalHands}</p>
          </div>
          <div>
            <p className="font-semibold text-yellow-300">Victoires</p>
            <p>{stats.totalWins}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default PokerPage;
