"use client";

import { useState, useEffect, useRef } from "react";
import UnoCard from "../../../components/UnoCard"; 
import UnoBack from "../../../components/UnoBack"; 
import NavigationBar from "../../../components/navigation-bar";

export default function UnoGamePage() {
  const [game, setGame] = useState(null);
  const [gameMode, setGameMode] = useState("ai");
  const [playerHand, setPlayerHand] = useState([]);
  const [aiHandCount, setAiHandCount] = useState(0);
  const [topCard, setTopCard] = useState(null);
  const [isPlayerTurn, setIsPlayerTurn] = useState(true);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [betAmount, setBetAmount] = useState(100);
  const [tokens, setTokens] = useState(null);
const [showColorPicker, setShowColorPicker] = useState(false);
const [pendingCard, setPendingCard] = useState(null);
const [turnHistory, setTurnHistory] = useState([]);
const [historyIndex, setHistoryIndex] = useState(null); // null = live game
const [showGameModeModal, setShowGameModeModal] = useState(false);
const [availableGames, setAvailableGames] = useState([]);
const [isLoadingAvailableGames, setIsLoadingAvailableGames] = useState(false);
const [waitingGameId, setWaitingGameId] = useState(null);
const [isCancellingWaitingGame, setIsCancellingWaitingGame] = useState(false);
const waitingPollRef = useRef(null);

useEffect(() => {
  fetchAvailableGames();
}, []);

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

  const fetchAvailableGames = async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    if (game || waitingGameId) return;
    setIsLoadingAvailableGames(true);
    try {
      const res = await fetch("/api/uno/available-games", {
        method: "GET",
        credentials: "include",
      });
      const data = await res.json();
      if (data.success) {
        setAvailableGames(data.data || []);
      }
    } catch (err) {
      console.error("Erreur lors du chargement des parties disponibles:", err);
    }
    setIsLoadingAvailableGames(false);
  };
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
        if (gameMode === "online") {
          const youWon = data.result === "win";
          setMessage(youWon ? "🎉 Tu as gagné la partie !" : "😢 Ton adversaire a gagné la partie !");
        } else {
          setMessage(`🎉 ${data.winner} a gagné la partie !`);
        }
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
      credentials: "include",
      body: JSON.stringify({ betAmount }),
    });

    const data = await res.json();
    if (data.success) {
      setGameMode("ai");
      setGame(data.data);
      setPlayerHand(data.data.playerHand);
      setAiHandCount(data.data.aiHand.length);
      if (data.data.topCard) {
  setTopCard(data.data.topCard);
  setTurnHistory((prev) => [...prev, data.data.topCard]);
}
setHistoryIndex(null); // back to live mode
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
  setTopCard(data.data.topCard);
setTurnHistory((prev) => [...prev, data.data.topCard]);
setHistoryIndex(null); // back to live mode

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
  if (historyIndex !== null) return; // block while browsing history

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
    setTurnHistory((prev) => [...prev, data.data.topCard]);
    setHistoryIndex(null); // back to live mode
    setAiHandCount(data.data.aiHandCount ?? data.data.opponentHandCount ?? 0);
    setIsPlayerTurn(data.data.isPlayerTurn);
    setMessage(data.data.message || "À ton tour !");
    setPendingCard(null);       // ✅ clear pending card
    setShowColorPicker(false);  // ✅ make sure popup closes
    await checkForWinner(game.id);

    if (!data.data.isPlayerTurn && gameMode === "ai") {
      setTimeout(() => handleAITurn(game.id), 1000);
    }
  } else {
    setMessage(data.error);
  }

  setLoading(false);
};
const waitForOnlineGameStart = (gameId) => {
  if (waitingPollRef.current) {
    clearInterval(waitingPollRef.current);
    waitingPollRef.current = null;
  }

  waitingPollRef.current = setInterval(async () => {
    try {
      const res2 = await fetch("/api/uno/check-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId }),
      });
      const d2 = await res2.json();

      if (d2.success && d2.status === "active") {
        clearInterval(waitingPollRef.current);
        waitingPollRef.current = null;
        setWaitingGameId(null);
        setGameMode("online");
        setGame(d2.data);
        setPlayerHand(d2.data.playerHand);
        setAiHandCount(d2.data.opponentHandCount);
        setTopCard(d2.data.topCard);
        setTurnHistory([d2.data.topCard]);
        setIsPlayerTurn(d2.data.turn === d2.data.role);
        setMessage("✅ Partie trouvée !");
      }
    } catch (err) {
      console.error("Erreur check-game:", err);
    }
  }, 3000);
};

const cancelWaitingOnlineGame = async () => {
  if (!waitingGameId || isCancellingWaitingGame) return;

  setIsCancellingWaitingGame(true);
  try {
    const res = await fetch("/api/uno/cancel-waiting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ gameId: waitingGameId }),
    });
    const data = await res.json();

    if (data.success) {
      if (waitingPollRef.current) {
        clearInterval(waitingPollRef.current);
        waitingPollRef.current = null;
      }
      setWaitingGameId(null);
      setMessage("✅ Partie annulée.");
      if (data.newBalance) {
        setTokens({ balance: data.newBalance });
      }
      fetchAvailableGames();
    } else {
      setMessage(data.error || "Impossible d'annuler la partie.");
    }
  } catch (err) {
    console.error("Erreur cancelWaitingOnlineGame:", err);
    setMessage("Impossible d'annuler la partie.");
  }
  setIsCancellingWaitingGame(false);
};

const joinSpecificOnlineGame = async (gameId) => {
  if (loading) return;
  setLoading(true);
  try {
    const res = await fetch("/api/uno/join-online", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ mode: "join-specific", gameId }),
    });

    const data = await res.json();

    if (data.success) {
      setWaitingGameId(null);
      setGameMode("online");
      setGame(data.data);
      setPlayerHand(data.data.playerHand);
      setAiHandCount(data.data.opponentHandCount);
      setTopCard(data.data.topCard);
      setTurnHistory([data.data.topCard]);
      setIsPlayerTurn(data.data.turn === (data.data.role || "player2"));
      setMessage("✅ Partie en ligne trouvée !");
      setTokens({ balance: data.data.newBalance });
      fetchAvailableGames();
    } else {
      setMessage(data.error || "Impossible de rejoindre cette partie");
      fetchAvailableGames();
    }
  } catch (err) {
    console.error("Erreur joinSpecificOnlineGame:", err);
    setMessage("Impossible de rejoindre cette partie");
  }
  setLoading(false);
};

const joinOnlineGame = async () => {
  setLoading(true);
  try {
    const res = await fetch("/api/uno/join-online", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ mode: "join-random" }),
    });

    const data = await res.json();

    if (data.success) {
      if (waitingPollRef.current) {
        clearInterval(waitingPollRef.current);
        waitingPollRef.current = null;
      }
      setWaitingGameId(null);
      setGameMode("online");
      setGame(data.data);
      setPlayerHand(data.data.playerHand);
      setAiHandCount(data.data.opponentHandCount);
      setTopCard(data.data.topCard);
      setTurnHistory([data.data.topCard]);
      setIsPlayerTurn(data.data.turn === (data.data.role || "player2"));
      setMessage("✅ Partie en ligne trouvée !");
      setTokens({ balance: data.data.newBalance });
      fetchAvailableGames();
    } else {
      setMessage(data.error || "Erreur lors de la recherche de partie");
    }
  } catch (err) {
    console.error("Erreur joinOnlineGame:", err);
    setMessage("Impossible de rejoindre une partie");
  }
  setLoading(false);
};

const createOnlineGame = async () => {
  setLoading(true);
  setShowGameModeModal(false);

  try {
    const res = await fetch("/api/uno/join-online", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ mode: "create", betAmount }),
    });

    const data = await res.json();
    if (data.success && data.waiting) {
      setMessage("⏳ En attente d'un autre joueur...");
      setGameMode("online");
      setWaitingGameId(data.gameId);
      if (data.newBalance) {
        setTokens({ balance: data.newBalance });
      }
      waitForOnlineGameStart(data.gameId);
      fetchAvailableGames();
    } else {
      setMessage(data.error || "Impossible de créer la partie en ligne");
    }
  } catch (err) {
    console.error("Erreur createOnlineGame:", err);
    setMessage("Impossible de créer la partie en ligne");
  }
  setLoading(false);
};

useEffect(() => {
  if (!game?.id || gameMode !== "online") return;

  const interval = setInterval(async () => {
    try {
      const res = await fetch("/api/uno/check-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gameId: game.id }),
      });
      const data = await res.json();

      if (!data.success || !data.data) return;

      setPlayerHand(data.data.playerHand);
      setAiHandCount(data.data.opponentHandCount);
      setTopCard(data.data.topCard);
      setIsPlayerTurn(data.data.turn === data.data.role);
      setTurnHistory((prev) => {
        const last = prev[prev.length - 1];
        const sameCard = last?.color === data.data.topCard?.color && last?.value === data.data.topCard?.value;
        if (sameCard) return prev;
        return [...prev, data.data.topCard];
      });
    } catch (err) {
      console.error("Erreur sync online:", err);
    }
  }, 2000);

  return () => clearInterval(interval);
}, [game?.id, gameMode]);

useEffect(() => {
  return () => {
    if (waitingPollRef.current) {
      clearInterval(waitingPollRef.current);
      waitingPollRef.current = null;
    }
  };
}, []);


const drawCard = async () => {
    if (!isPlayerTurn || loading) return;
    if (historyIndex !== null) return; // block while browsing history
    setLoading(true);
    const res = await fetch("/api/uno/draw-card", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gameId: game.id }),
    });

    const data = await res.json();
    if (data.success) {
  setPlayerHand(data.data.playerHand);
  setTopCard(data.data.topCard);
setTurnHistory((prev) => [...prev, data.data.topCard]);
setHistoryIndex(null); // back to live mode

  setAiHandCount(data.data.aiHandCount ?? data.data.opponentHandCount ?? aiHandCount);
  setIsPlayerTurn(data.data.isPlayerTurn);
  setMessage(gameMode === "ai" ? "L'IA joue..." : "Tour adverse...");
  await checkForWinner(game.id);

  if (gameMode === "ai") {
    setTimeout(() => handleAITurn(game.id), 1000);
  }
}
else {
      setMessage(data.error);
    }
    setLoading(false);
  };
const displayedCard =
  historyIndex === null
    ? topCard
    : turnHistory[historyIndex];

return (

  <div className="bg-[#003366] min-h-screen flex flex-col items-center justify-center text-white px-4 py-8">
 <NavigationBar currentPath="/casino" />
    <h1 className="text-3xl mb-2 font-bold">{gameMode === "online" ? "UNO 1v1 en ligne" : "UNO vs IA"}</h1>

    {tokens && (
      <p className="text-yellow-300 mb-4 text-lg">
        💰 Tokens : {tokens.balance}
      </p>
    )}

    {!game ? (
  <div className="w-full max-w-4xl aspect-[2/1] bg-green-700 rounded-full flex flex-col items-center justify-center shadow-2xl border-8 border-green-900 p-8 text-center">
    <h2 className="text-2xl font-bold mb-6 text-white">Prépare ta partie</h2>

    <label className="mb-6 text-lg font-semibold flex flex-col items-center">
      <span className="mb-2">Mise :</span>
      <input
        type="number"
        value={betAmount}
        onChange={(e) => setBetAmount(Number(e.target.value))}
        className="text-black px-3 py-1 rounded text-center w-32"
        min={1}
        max={1000}
      />
    </label>

    <button
      onClick={() => setShowGameModeModal(true)}
      disabled={loading || !!waitingGameId}
      className="bg-yellow-500 hover:bg-yellow-600 text-black px-8 py-3 rounded-full font-bold shadow-lg transition"
    >
      {loading ? "Chargement..." : "Commencer une partie"}
    </button>
<button
  onClick={joinOnlineGame}
  disabled={loading || !!waitingGameId}
  className="mt-4 bg-blue-500 hover:bg-blue-600 text-white px-8 py-3 rounded-full font-bold shadow-lg transition"
>
  {loading ? "Recherche..." : "Rejoindre une partie"}
</button>
{waitingGameId && (
  <button
    onClick={cancelWaitingOnlineGame}
    disabled={isCancellingWaitingGame}
    className="mt-3 bg-red-500 hover:bg-red-600 text-white px-8 py-2 rounded-full font-bold shadow-lg transition"
  >
    {isCancellingWaitingGame ? "Annulation..." : "Annuler la partie en attente"}
  </button>
)}

    <div className="mt-6 w-full max-w-md bg-green-800/70 rounded-2xl p-4 border border-green-900">
      <div className="flex justify-between items-center mb-3">
  <h3 className="text-lg font-bold">Parties en ligne disponibles</h3>
  <button
    onClick={fetchAvailableGames}
    disabled={isLoadingAvailableGames}
    className="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded-md text-sm font-semibold"
  >
    {isLoadingAvailableGames ? "..." : "🔄 Refresh"}
  </button>
</div>
      {isLoadingAvailableGames ? (
        <p className="text-sm text-gray-200">Chargement des parties...</p>
      ) : availableGames.length === 0 ? (
        <p className="text-sm text-gray-200">Aucune partie en attente pour le moment.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {availableGames.slice(0, 6).map((onlineGame) => (
            <li
              key={onlineGame.id}
              className="flex justify-between items-center bg-green-900/60 rounded-lg px-3 py-2"
            >
              <span>
                {onlineGame.hostName} • Mise: {onlineGame.betAmount}
              </span>
              <button
                onClick={() => joinSpecificOnlineGame(onlineGame.id)}
                disabled={!onlineGame.canAfford || loading || !!waitingGameId}
                className={`px-3 py-1 rounded-md font-semibold ${
                  onlineGame.canAfford && !waitingGameId
                    ? "bg-blue-500 hover:bg-blue-600 text-white"
                    : "bg-gray-600 text-gray-200 cursor-not-allowed"
                }`}
              >
                {onlineGame.canAfford ? "Rejoindre" : "Solde insuffisant"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>

    {showGameModeModal && (
      <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
        <div className="bg-white text-black rounded-2xl p-6 w-full max-w-sm shadow-2xl">
          <h3 className="text-xl font-bold mb-4 text-center">Choisir un mode</h3>
          <div className="flex flex-col gap-3">
            <button
              onClick={() => {
                setShowGameModeModal(false);
                initializeGame();
              }}
              className="bg-yellow-500 hover:bg-yellow-600 text-black px-4 py-2 rounded-lg font-bold"
            >
              Jouer contre l'IA
            </button>
            <button
              onClick={createOnlineGame}
              disabled={!!waitingGameId}
              className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-lg font-bold"
            >
              Créer une partie multijoueur
            </button>
            <button
              onClick={() => setShowGameModeModal(false)}
              className="bg-gray-300 hover:bg-gray-400 text-black px-4 py-2 rounded-lg font-semibold"
            >
              Annuler
            </button>
          </div>
        </div>
      </div>
    )}


    {message && (
      <p className="mt-6 text-yellow-300 text-lg font-medium">{message}</p>
    )}
  </div>
) : (
  <div className="w-full max-w-5xl aspect-[2/1] bg-green-700 rounded-full flex flex-col justify-between items-center shadow-2xl border-8 border-green-900 p-6 relative">
    {/* Opponent hand */}
    {gameMode === "online" ? "Main adverse:" : "Main de l'IA:"}
    <div className="flex justify-center gap-2">
      {Array(aiHandCount)
        .fill(0)
        .map((_, i) => (
          <UnoBack key={i} />
        ))}
    </div>

{showColorPicker && (
  <div className="absolute inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50">
    <div className="bg-white p-8 rounded-2xl shadow-xl text-black flex flex-col items-center gap-6">
      <h2 className="text-xl font-bold mb-2">Choisis une couleur 🎨</h2>
      <div className="grid grid-cols-2 gap-4">
        {[
          { color: "red", label: "Rouge" },
          { color: "blue", label: "Bleu" },
          { color: "green", label: "Vert" },
          { color: "yellow", label: "Jaune" },
        ].map(({ color, label }) => (
          <button
            key={color}
            onClick={() => {
              setShowColorPicker(false);
              sendPlayCard(pendingCard, color); // ✅ send chosen color
            }}
            className="flex flex-col items-center justify-center w-24 h-24 rounded-xl font-bold text-white shadow-lg hover:scale-105 transition-transform"
            style={{ backgroundColor: color }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  </div>
)}

    {/* Center with arrows + current/past card */}
<div className="flex items-center justify-center gap-6 mb-4">
  {/* Left arrow */}
 <button
  onClick={() =>
    setHistoryIndex((prev) => {
      if (turnHistory.length <= 1) return null;
      if (prev === null) return turnHistory.length - 2; // jump to last turn before live
      return Math.max(prev - 1, 0); // go back but not before first card
    })
  }
  disabled={turnHistory.length <= 1 || historyIndex === 0}
  className="text-3xl font-bold text-yellow-300 hover:scale-110 transition disabled:opacity-30"
  title="Tour précédent"
>
  ⬅️
</button>


  {/* Card in center */}
  <div className="flex flex-col items-center">
    Carte actuelle :
    {displayedCard ? (
      <UnoCard
        color={displayedCard.color}
        value={displayedCard.value}
        onClick={() => {}}
      />
    ) : (
      <span className="font-bold ml-2">?</span>
    )}
    {historyIndex !== null && (
      <p className="text-sm text-gray-300 mt-2">
        Historique ({historyIndex + 1}/{turnHistory.length})
      </p>
    )}
  </div>

  {/* Right arrow */}
 <button
  onClick={() =>
    setHistoryIndex((prev) => {
      if (prev === null) return null; // already live
      if (prev >= turnHistory.length - 2) return null; // next step would be live
      return prev + 1;
    })
  }
  disabled={historyIndex === null}
  className="text-3xl font-bold text-yellow-300 hover:scale-110 transition disabled:opacity-30"
  title="Tour suivant"
>
  ➡️
</button>

</div>


    {/* Player hand */}
    <div className="flex flex-wrap gap-2 justify-center">
      {playerHand.map((card, i) => (
        <UnoCard
          key={i}
          color={card.color}
          value={card.value}
          onClick={() => playCard(card)}
        />
      ))}
    </div>
{historyIndex === null ? (
  <p className="text-sm text-green-300 mt-2">En direct</p>
) : (
  <p className="text-sm text-gray-300 mt-2">
    Historique ({historyIndex + 1}/{turnHistory.length})
  </p>
)}

    {/* Draw & replay buttons */}
    <div className="flex flex-col items-center mt-4">
      <button
        onClick={drawCard}
        className="mb-2 bg-yellow-500 hover:bg-yellow-600 text-black px-4 py-2 rounded"
      >
        Piocher une carte
      </button>

      {!isPlayerTurn && game && message.includes("a gagné") && (
        <button
          onClick={async () => {
            setMessage("");
            setGame(null);
            setPlayerHand([]);
            setAiHandCount(0);
            setTopCard(null);
            setIsPlayerTurn(true);
            setPendingCard(null);
            setShowColorPicker(false);
            await initializeGame();
          }}
          disabled={loading}
          className="bg-green-600 hover:bg-green-700 text-white px-6 py-2 rounded"
        >
          {loading ? "Chargement..." : "Rejouer"}
        </button>
      )}
    </div>
  </div>
)}

  </div>
);
}
