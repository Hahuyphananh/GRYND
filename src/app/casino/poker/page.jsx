"use client";

import React, { useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";

export default function PokerPage() {
  const { user } = useUser();
  const router = useRouter();

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
  const [betAmount, setBetAmount] = useState(10); // new state for bet input

  // --- SAME CARD GENERATOR AS BLACKJACK ---
  const getRandomCard = () => {
    const suits = ["♠", "♥", "♦", "♣"];
    const values = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
    return {
      suit: suits[Math.floor(Math.random() * suits.length)],
      value: values[Math.floor(Math.random() * values.length)],
    };
  };

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
      body: JSON.stringify({ betAmount }) // send user-chosen bet
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error);

      // --- Use card objects ---
      const playerCards = [getRandomCard(), getRandomCard()];
      const aiCards = [getRandomCard(), getRandomCard()]; // real cards, same as player


      setGame(data.game);
      setPlayerHand(playerCards);
      setOpponentHand(aiCards);
      setPot(data.pot || 20);
      setResult(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const initializeAiGame = async () => {
  try {
    setLoading(true);
    setError(null);

    const response = await fetch("/api/initialize-poker-vs-ai", {
       method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ betAmount }) // send user-chosen bet
    });

    const data = await response.json();
    if (!response.ok || !data.success) {
      setError(data.error || "Erreur lors de l'initialisation contre l'IA");
      return;
    }

    setGame({ id: data.data.gameId });

    // --- Deal hole cards ---
    const playerCards = [getRandomCard(), getRandomCard()];
    const aiCards = [{ value: "?", suit: "?" }, { value: "?", suit: "?" }];

    setPlayerHand(playerCards);
    setOpponentHand(aiCards);
    setPot(data.data.pot ?? 20);
    setUserTokens(data.data.newBalance);
    setResult(null);

  } catch (error) {
    setError("Impossible de démarrer la partie contre l’IA");
    console.error("Erreur:", error);
  } finally {
    setLoading(false);
  }
};


const handleAction = async (action) => {
  if (!game) return;

  try {
    const payload = { gameId: game.id, action };

    const res = await fetch("/api/handle-poker-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error);

    // Update game state from backend
    setGame(data.game);
    setPot(data.game.pot || 0);

    if (data.result) {
      setResult(data.result);

      // --- Map suits to symbols for AI hand before revealing ---
      const suitSymbols = {
        hearts: "♥",
        diamonds: "♦",
        clubs: "♣",
        spades: "♠",
      };

      const revealedAiHand = data.game.aiHand.map(c => ({
        value: c.value,
        suit: suitSymbols[c.suit] || c.suit,
      }));

      setOpponentHand(revealedAiHand); // Reveal AI hand with proper symbols
    }

  } catch (e) {
    console.error("Error in handleAction:", e);
    setError(e.message);
  }
};



  // --- Card Renderer identical to Blackjack ---
 const renderCard = (card, i) => (
  <div
    key={i}
    className="h-32 w-24 bg-white text-xl flex items-center justify-center rounded shadow"
    style={{
      color: ["♥", "♦"].includes(card.suit) ? "red" : "black",
    }}
  >
    {`${card.value}${card.suit}`}
  </div>
);


  return (
    <div className="min-h-screen bg-[#003366] pt-20">
      {/* ✅ Return to Casino Button */}
      <button
        onClick={() => router.push("/casino")}
        className="absolute top-4 left-4 bg-gray-700 hover:bg-gray-800 text-white px-4 py-2 rounded shadow"
      >
        ⬅ Return to Casino
      </button>

      <div className="mx-auto max-w-4xl px-4 py-8">
        <h1 className="text-4xl font-bold text-[#FFD700] text-center mb-6">
          ♠️ Poker Royale
        </h1>
        <p className="text-lg font-semibold text-[#FFD700] text-center">
          🪙 Tokens: {userTokens}
        </p>

        {error && <div className="mb-4 rounded bg-red-500/10 p-3 text-red-500">{error}</div>}

        {!game && (
  <div className="text-center mt-8 space-y-4">
    
    {/* --- Bet Amount Input --- */}
    <div className="flex justify-center items-center gap-2">
      <label className="text-[#FFD700] font-semibold">Bet Amount:</label>
      <input
        type="number"
        value={betAmount}
        min="1"
        max={userTokens}
        onChange={(e) => setBetAmount(parseInt(e.target.value))}
        className="w-24 px-2 py-1 rounded text-black"
      />
    </div>

    <button
      onClick={() => initializeGame(betAmount)}
      className="bg-yellow-400 hover:bg-yellow-300 text-black px-6 py-3 rounded-full font-bold"
    >
      Nouvelle Partie
    </button>
    <button
      onClick={() => initializeAiGame(betAmount)}
      className="bg-purple-600 hover:bg-purple-700 text-white font-bold py-3 px-6 rounded shadow"
    >
      Jouer contre l’IA ♠️
    </button>
  </div>
)}

        {game && (
          <div className="mt-8 rounded-lg bg-[#0e6b0e] p-6 border-[10px] border-[#5c3b15] shadow-inner">
            <div className="flex justify-center gap-8 mb-4">
              <div>
                <h3 className="text-[#FFD700] text-center mb-2">Votre main</h3>
                <div className="flex gap-2 justify-center">{playerHand.map(renderCard)}</div>
              </div>
              <div>
                <h3 className="text-[#FFD700] text-center mb-2">Main AI</h3>
                <div className="flex gap-2 justify-center">{opponentHand.map(renderCard)}</div>
              </div>
            </div>

            <div className="text-center text-[#FFD700] font-semibold text-lg mb-4">
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
    onClick={() => {
      // In Casino Hold'em, "Play" = fixed raise (usually 2x ante)
      setRaiseAmount(pot / 10 * 2); // example: ante = pot/10, play bet = 2x ante
      handleAction("play");
    }}
    className="bg-green-600 hover:bg-green-700 px-4 py-2 rounded-full font-bold"
  >
    Play
  </button>
</div>

          </div>
        )}

        {result && (
  <div className="mt-6 text-center space-y-4">
    <p className="text-xl font-bold text-[#FFD700]">
      {result.message} {result.won && `+${result.winAmount} tokens! 🎉`}
    </p>

    {/* Replay button */}
    <button
      onClick={() => {
        setResult(null); // clear previous result
        setGame(null);   // reset game state so new one initializes
        // You can choose AI or normal game depending on how it ended
        initializeAiGame(); 
      }}
      className="bg-blue-600 hover:bg-blue-700 text-white font-bold px-6 py-3 rounded-full"
    >
      🔄 Replay
    </button>
  </div>
)}


        <div className="mt-10 grid grid-cols-3 gap-6 text-white text-center">
          <div>
            <p className="font-semibold text-[#FFD700]">Plus gros gain</p>
            <p>{stats.biggestWin} tokens</p>
          </div>
          <div>
            <p className="font-semibold text-[#FFD700]">Mains jouées</p>
            <p>{stats.totalHands}</p>
          </div>
          <div>
            <p className="font-semibold text-[#FFD700]">Victoires</p>
            <p>{stats.totalWins}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
