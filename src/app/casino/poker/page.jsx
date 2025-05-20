"use client";

import React, { useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";

function MainComponent() {
  const { isLoaded, isSignedIn, user } = useUser();

  const [game, setGame] = useState(null);
  const [error, setError] = useState(null);
  const [playerPosition, setPlayerPosition] = useState(null);
  const [raiseAmount, setRaiseAmount] = useState(0);
  const [loading, setLoading] = useState(true);

  const tables = [
    { name: "Débutant", minBuy: 100, smallBlind: 0.5, bigBlind: 1 },
    { name: "Amateur", minBuy: 500, smallBlind: 2.5, bigBlind: 5 },
    { name: "Intermédiaire", minBuy: 1000, smallBlind: 5, bigBlind: 10 },
    { name: "Semi-Pro", minBuy: 5000, smallBlind: 25, bigBlind: 50 },
    { name: "Professionnel", minBuy: 10000, smallBlind: 50, bigBlind: 100 },
    { name: "High Roller", minBuy: 50000, smallBlind: 250, bigBlind: 500 },
    { name: "Elite", minBuy: 100000, smallBlind: 500, bigBlind: 1000 },
  ];

  useEffect(() => {
    if (isLoaded && isSignedIn && user) {
      checkExistingGame();
    }
  }, [isLoaded, isSignedIn, user]);

  const checkExistingGame = async () => {
    try {
      setLoading(true);
      const response = await fetch("/api/get-active-poker-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id }),
      });

      if (!response.ok) throw new Error("Erreur lors de la vérification du jeu");

      const data = await response.json();
      if (data.game) {
        setGame(data.game);
        setPlayerPosition(data.positions.find((p) => p.player_id === user.id));
      }
    } catch (error) {
      console.error("Erreur:", error);
    } finally {
      setLoading(false);
    }
  };

  const initializeGame = async (tableIndex) => {
    try {
      setLoading(true);
      setError(null);
      const selectedTable = tables[tableIndex];

      const response = await fetch("/api/initialize-poker-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          smallBlind: selectedTable.smallBlind,
          bigBlind: selectedTable.bigBlind,
          minBuy: selectedTable.minBuy,
        }),
      });

      const data = await response.json();
      if (!response.ok || data.error) {
        setError(data.error || "Erreur lors de l'initialisation du jeu");
        return;
      }

      setGame(data.game);
      setPlayerPosition(data.positions.find((p) => p.player_id === user.id));
    } catch (error) {
      setError("Impossible de démarrer une nouvelle partie");
      console.error("Erreur:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleAction = async (action, amount = null) => {
    try {
      setError(null);
      const response = await fetch("/api/handle-poker-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameId: game.id,
          action,
          amount,
          userId: user.id,
        }),
      });

      const data = await response.json();
      if (!response.ok || data.error) {
        setError(data.error || "Erreur lors de l'action");
        return;
      }

      setGame(data.game);
      setPlayerPosition(data.positions.find((p) => p.player_id === user.id));
      setRaiseAmount(0);
    } catch (error) {
      setError("Erreur lors de l'action");
      console.error("Erreur:", error);
    }
  };

  const endGame = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch("/api/end-poker-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gameId: game.id,
          userId: user.id,
        }),
      });

      const data = await response.json();
      if (!response.ok || data.error) {
        setError(data.error || "Erreur lors de la fin de partie");
        return;
      }

      setGame(null);
      setPlayerPosition(null);
    } catch (error) {
      setError("Impossible de terminer la partie");
      console.error("Erreur:", error);
    } finally {
      setLoading(false);
    }
  };

  const renderCard = (card) => {
    if (!card) return null;
    const suitSymbols = {
      hearts: "♥",
      diamonds: "♦",
      clubs: "♣",
      spades: "♠",
    };
    const suitColor =
      card.suit === "hearts" || card.suit === "diamonds"
        ? "text-red-500"
        : "text-black";

    return (
      <div className="flex items-center justify-center w-12 h-16 bg-white rounded-lg shadow-md m-1">
        <span className={suitColor}>
          {card.value}
          {suitSymbols[card.suit]}
        </span>
      </div>
    );
  };

  if (!isLoaded) return null;

  if (!isSignedIn) {
    return (
      <div className="min-h-screen bg-[#003366] text-white p-8">
        <div className="text-center">
          <p>Veuillez vous connecter pour jouer au poker</p>
          <a
            href="/account/signin?callbackUrl=/casino/poker"
            className="mt-4 inline-block bg-[#FFD700] text-black px-6 py-2 rounded hover:bg-[#FFD700]/80"
          >
            Se connecter
          </a>
        </div>
      </div>
    );
  }

  // ✅ Render your game UI here, as you already have in your version (not duplicated below for brevity)
  // Just include this fixed structure with the updated imports and `useUser` handling.
  return (
    <div className="min-h-screen bg-[#003366] text-white">
      {/* ... your original UI rendering code (game board, actions, buttons, etc.) ... */}
      {/* Ensure it's placed after the check for `isLoaded && isSignedIn` */}
    </div>
  );
}

export default MainComponent;
