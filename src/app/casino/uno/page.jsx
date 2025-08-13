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
  const [colorChoice, setColorChoice] = useState(null);
const [showColorPicker, setShowColorPicker] = useState(false);
const [pendingCard, setPendingCard] = useState(null);


  const router = useRouter();

  // ✅ Load tokens on page mount
  useEffect(() => {
    const fetchTokens = async () => {
      try {
        const res = await fetch("/api/get-user-tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
        });
        const data = await res.json();
        if (data.success) {
          setTokens({ balance: data.data.balance });
        }
      } catch (err) {
        console.error("Erreur lors du chargement des tokens:", err);
      }
    };
    fetchTokens();
  }, []);

  // ✅ Winner check helper
  const checkForWinner = async (gameId) => {
    try {
      const res = await fetch("/api/uno/determine-winner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      });
      const data = await res.json();
      if (data.winner) {
        setMessage(`🎉 ${data.winner} a gagné la partie !`);
        setIsPlayerTurn(false);
      }
    } catch (err) {
      console.error("Erreur lors de la vérification du gagnant:", err);
    }
  };

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
      setTokens({ balance: data.data.newBalance }); // ✅ update tokens
    } else {
      setMessage("Erreur d'initialisation");
    }
    setLoading(false);
  };

  const handleAITurn = async (gameId) => {
    try {
      const res = await fetch("/api/uno/ai-turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      });
      const data = await res.json();
      if (data.success) {
  setPlayerHand(data.data.playerHand);
  setAiHandCount(data.data.aiHandCount);
  setTopCard(data.data.topCard);  // <-- update top card here exactly
  setIsPlayerTurn(data.data.isPlayerTurn);
  setMessage(data.data.message || "À ton tour !");
  setTokens({ balance: data.data.newBalance });
  await checkForWinner(gameId);
}


    } catch (err) {
      console.error("Erreur IA:", err);
    }
  };

 const playCard = async (card) => {
  if (!isPlayerTurn || loading) return;

  // If it's a wild or black card, ask for color first
  if (card.color === "wild" || card.color === "black") {
    setPendingCard(card);
    setShowColorPicker(true);
    return;
  }

  // Otherwise play as usual
  await sendPlayCard(card);
};

const sendPlayCard = async (card, chosenColor = null) => {
  setLoading(true);

  // Only ask for color if it's wild AND no color has been chosen yet
  if ((card.color === "wild" || card.color === "black") && !chosenColor) {
    setPendingCard(card);
    setShowColorPicker(true);
    setLoading(false);
    return;
  }

  const res = await fetch("/api/uno/play-card", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gameId: game.id, card, chosenColor }),
  });

  const data = await res.json();

  if (data.success) {
    if (data.needsColorChoice) {
      setPendingCard(data.card);
      setShowColorPicker(true);
      setLoading(false);
      return;
    }

    setPlayerHand(data.data.playerHand);
    setTopCard(data.data.topCard);
    setAiHandCount(data.data.aiHandCount);
    setIsPlayerTurn(data.data.isPlayerTurn);
    setMessage(data.data.message || "À ton tour !");
    setPendingCard(null);       // ✅ clear pending card
    setShowColorPicker(false);  // ✅ make sure popup closes
    await checkForWinner(game.id);

    if (!data.data.isPlayerTurn) {
      setTimeout(() => handleAITurn(game.id), 1000);
    }
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId: game.id }),
    });

    const data = await res.json();
    if (data.success) {
  setPlayerHand(data.data.playerHand);
  setTopCard(data.data.topCard);  // ✅ update top card immediately
  setIsPlayerTurn(false);
  setMessage("L'IA joue...");
  await checkForWinner(game.id);

  setTimeout(() => handleAITurn(game.id), 1000);
}
else {
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

      {tokens && (
        <p className="text-yellow-300 mb-4 text-lg">
          💰 Tokens : {tokens.balance}
        </p>
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
    {topCard
      ? `${topCard.chosenColor || topCard.color} ${topCard.value}`
      : "?"}
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
          {showColorPicker && (
  <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center">
    <div className="bg-white p-6 rounded shadow-lg text-black">
      <h2 className="mb-4 font-bold">Choisis une couleur :</h2>
      <div className="flex gap-4">
      {["red", "yellow", "green", "blue"].map((color) => (
  <button
    key={color}
    onClick={() => {
      setShowColorPicker(false);
      if (pendingCard) {
        // Pass chosenColor as second argument
        sendPlayCard(pendingCard, color);
        setPendingCard(null);
      }
    }}
    className={`px-4 py-2 rounded font-bold ${
      color === "red"
        ? "bg-red-500"
        : color === "yellow"
        ? "bg-yellow-400"
        : color === "green"
        ? "bg-green-500"
        : "bg-blue-500"
    }`}
  >
    {color.toUpperCase()}
  </button>
))}

      </div>
    </div>
  </div>
)}

<div className="flex flex-col items-center mt-4">
  {/* Draw card button */}
  <button
    onClick={drawCard}
    className="mb-2 bg-yellow-500 hover:bg-yellow-600 text-black px-4 py-2 rounded"
  >
    Piocher une carte
  </button>

  {/* Replay button if game is finished */}
{!isPlayerTurn && game && message.includes("a gagné") && (
  <button
    onClick={async () => {
      // Reset frontend state
      setMessage("");
      setGame(null);
      setPlayerHand([]);
      setAiHandCount(0);
      setTopCard(null);
      setIsPlayerTurn(true);
      setPendingCard(null);
      setShowColorPicker(false);

      // Start a new game safely
      await initializeGame();
    }}
      disabled={loading}
      className="bg-green-600 hover:bg-green-700 text-white px-6 py-2 rounded"
    >
      {loading ? "Chargement..." : "Rejouer"}
    </button>
  )}
</div>

        </>
      )}
    </div>
  );
}
