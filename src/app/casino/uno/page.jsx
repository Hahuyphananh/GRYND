"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function UnoGamePage() {
  const [game, setGame] = useState(null);
  const [playerHand, setPlayerHand] = useState([]);
  const [aiHandCount, setAiHandCount] = useState(0);
  const [topCard, setTopCard] = useState(null);
  const [isPlayerTurn, setIsPlayerTurn] = useState(true);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [betAmount, setBetAmount] = useState(100);
  const [tokens, setTokens] = useState(null);

  const router = useRouter();

  // ✅ Charger les tokens à l’arrivée sur la page
useEffect(() => {
  const fetchTokens = async () => {
    console.log("Calling /api/get-user-tokens...");
    try {
      const res = await fetch("/api/get-user-tokens", {
        method: "POST", // ✅ MUST be GET to match your API route
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
      });

      console.log("Response status:", res.status);

      const data = await res.json();
      console.log("Token fetch response:", data);

      if (data.success) {
        setTokens(data.data);
      } else {
        console.warn("Token fetch failed:", data.error);
      }
    } catch (err) {
      console.error("Erreur lors du chargement des tokens:", err);
    }
  };

  fetchTokens();
}, []);


  const initializeGame = async () => {
    setLoading(true);
    const res = await fetch("/api/uno/initialize-vs-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ betAmount }),
    });

    const data = await res.json();
    if (data.success) {
      setGame(data.data);
      setPlayerHand(data.data.playerHand);
      setAiHandCount(data.data.aiHand.length);
      setTopCard(data.data.topCard);
      setIsPlayerTurn(true);
      setMessage("À ton tour !");
      setTokens(data.data.newBalance); // mettre à jour les tokens
    } else {
      setMessage("Erreur d'initialisation");
    }
    setLoading(false);
  };

  const playCard = async (card) => {
    if (!isPlayerTurn || loading) return;
    setLoading(true);
    const res = await fetch("/api/uno/play-card", {
      method: "POST",
      body: JSON.stringify({ gameId: game.id, card }),
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();
    if (data.success) {
      setPlayerHand(data.data.playerHand);
      setTopCard(data.data.topCard);
      setAiHandCount(data.data.aiHandCount);
      setIsPlayerTurn(data.data.isPlayerTurn);
      setMessage(data.data.message);
    } else {
      setMessage(data.error);
    }
    setLoading(false);
  };

  const drawCard = async () => {
    if (!isPlayerTurn || loading) return;
    setLoading(true);
    const res = await fetch("/api/uno/draw-card", {
      method: "POST",
      body: JSON.stringify({ gameId: game.id }),
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();
    if (data.success) {
      setPlayerHand(data.data.playerHand);
      setMessage(data.data.message);
      setIsPlayerTurn(data.data.isPlayerTurn);
    } else {
      setMessage(data.error);
    }
    setLoading(false);
  };

  return (
    <div className="bg-[#003366] min-h-screen flex flex-col items-center justify-center text-white px-4 py-8">
      <div className="absolute top-4 left-4">
        <button
          onClick={() => router.push("/casino")}
          className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded"
        >
          ⬅ Retour au casino
        </button>
      </div>

      <h1 className="text-3xl mb-2 font-bold">UNO vs IA</h1>

      {/* ✅ Affichage des tokens */}
      {tokens !== null && (
        <p className="text-yellow-300 mb-4 text-lg">💰 Tokens : {tokens.balance}</p>
      )}

      {!game ? (
        <>
          <label className="mb-4">
            Mise :
            <input
              type="number"
              value={betAmount}
              onChange={(e) => setBetAmount(Number(e.target.value))}
              className="ml-2 text-black px-2 py-1 rounded"
              min={1}
              max={1000}
            />
          </label>

          <button
            onClick={initializeGame}
            disabled={loading}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded"
          >
            {loading ? "Chargement..." : "Commencer une partie"}
          </button>

          {message && <p className="mt-4 text-yellow-300">{message}</p>}
        </>
      ) : (
        <>
          <div className="mb-4">
            Carte actuelle :
            <span className="font-bold ml-2">
              {topCard ? `${topCard.color} ${topCard.value}` : "?"}
            </span>
          </div>

          <div className="mb-6">
            <h2 className="text-lg">Main de l’IA : {aiHandCount} cartes</h2>
            <div className="flex gap-2">
              {Array(aiHandCount)
                .fill("🂠")
                .map((_, i) => (
                  <div key={i} className="bg-gray-600 w-8 h-12 rounded" />
                ))}
            </div>
          </div>

          <div className="text-center mb-6">{message}</div>

          <div className="flex flex-wrap gap-2 justify-center">
            {playerHand.map((card, i) => (
              <button
                key={i}
                onClick={() => playCard(card)}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded"
              >
                {card.color} {card.value}
              </button>
            ))}
          </div>

          <button
            onClick={drawCard}
            className="mt-4 bg-yellow-500 hover:bg-yellow-600 text-black px-4 py-2 rounded"
          >
            Piocher une carte
          </button>
        </>
      )}
    </div>
  );
}
