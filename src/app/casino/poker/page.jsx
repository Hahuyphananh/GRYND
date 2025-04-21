"use client";
import React from "react";

function MainComponent() {
  const { data: user } = useUser();
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
    if (user) {
      checkExistingGame();
    }
  }, [user]);

  const checkExistingGame = async () => {
    try {
      setLoading(true);
      const response = await fetch("/api/get-active-poker-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id }),
      });

      if (!response.ok) {
        throw new Error("Erreur lors de la vérification du jeu");
      }

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

      if (!response.ok) {
        throw new Error("Erreur lors de l'initialisation du jeu");
      }

      const data = await response.json();
      if (data.error) {
        setError(data.error);
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

      if (!response.ok) {
        throw new Error("Erreur lors de l'action");
      }

      const data = await response.json();
      if (data.error) {
        setError(data.error);
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

      if (!response.ok) {
        throw new Error("Erreur lors de la fin de partie");
      }

      const data = await response.json();
      if (data.error) {
        setError(data.error);
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

  if (!user) {
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

  return (
    <div className="min-h-screen bg-[#003366] text-white">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-4 flex justify-between items-center">
          <a
            href="/casino"
            className="inline-flex items-center bg-[#2A2B30] px-4 py-2 rounded text-white hover:bg-[#3A3B40]"
          >
            <i className="fas fa-arrow-left mr-2"></i>
            Retour au Casino
          </a>
          {game && (
            <button
              onClick={endGame}
              className="bg-red-600 px-4 py-2 rounded hover:bg-red-700 transition-colors"
            >
              Terminer la partie
            </button>
          )}
        </div>

        <div className="bg-[#1A1B1F] rounded-lg p-8">
          {error && (
            <div className="bg-red-500 text-white p-4 rounded mb-4">
              {error}
            </div>
          )}

          {loading ? (
            <div className="text-center py-8">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-white"></div>
              <p className="mt-2">Chargement...</p>
            </div>
          ) : !game ? (
            <div className="text-center py-8">
              <h2 className="text-2xl mb-6 text-[#FFD700]">
                Choisissez votre table
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {tables.map((table, index) => (
                  <div
                    key={index}
                    className="bg-[#2A2B30] p-6 rounded-lg hover:bg-[#3A3B40] transition-colors"
                  >
                    <h3 className="text-xl mb-3 text-[#FFD700]">
                      {table.name}
                    </h3>
                    <div className="space-y-2 text-gray-300">
                      <p>Buy-in minimum: {table.minBuy}$</p>
                      <p>Small Blind: {table.smallBlind}$</p>
                      <p>Big Blind: {table.bigBlind}$</p>
                    </div>
                    <button
                      onClick={() => initializeGame(index)}
                      className="mt-4 w-full bg-[#FFD700] text-black px-6 py-2 rounded hover:bg-[#FFD700]/80"
                    >
                      Rejoindre
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-8">
              {/* Table de poker */}
              <div className="relative bg-green-800 rounded-full aspect-[2/1] p-8">
                {/* Cartes communes */}
                <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 flex space-x-2">
                  {game.community_cards?.map((card, index) => renderCard(card))}
                </div>

                {/* Pot */}
                <div className="absolute top-1/4 left-1/2 transform -translate-x-1/2 text-center">
                  <div className="text-[#FFD700] text-xl">Pot: {game.pot}</div>
                </div>

                {/* Position du dealer */}
                <div className="absolute top-1/2 right-8 transform translate-y-1/2">
                  <div className="bg-white text-black rounded-full w-8 h-8 flex items-center justify-center">
                    D
                  </div>
                </div>

                {/* Blinds */}
                <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex space-x-4">
                  <div className="text-sm">
                    <span className="text-gray-300">Small Blind: </span>
                    <span className="text-[#FFD700]">{game.small_blind}</span>
                  </div>
                  <div className="text-sm">
                    <span className="text-gray-300">Big Blind: </span>
                    <span className="text-[#FFD700]">{game.big_blind}</span>
                  </div>
                </div>
              </div>

              {/* Cartes du joueur */}
              <div className="flex justify-center space-x-2">
                {game.player_hand?.map((card, index) => renderCard(card))}
              </div>

              {/* Phase de jeu */}
              <div className="text-center text-lg text-[#FFD700]">
                {game.current_round === "preflop" && "Pre-Flop"}
                {game.current_round === "flop" && "Flop"}
                {game.current_round === "turn" && "Turn"}
                {game.current_round === "river" && "River"}
              </div>

              {/* Actions du joueur */}
              {game.current_player_position === playerPosition?.position && (
                <div className="flex justify-center space-x-4 flex-wrap gap-2">
                  <button
                    onClick={() => handleAction("fold")}
                    className="bg-red-500 px-4 py-2 rounded hover:bg-red-600"
                  >
                    Se coucher
                  </button>

                  {game.min_bet === playerPosition?.current_bet && (
                    <button
                      onClick={() => handleAction("check")}
                      className="bg-blue-500 px-4 py-2 rounded hover:bg-blue-600"
                    >
                      Check
                    </button>
                  )}

                  {game.min_bet > playerPosition?.current_bet && (
                    <button
                      onClick={() => handleAction("call")}
                      className="bg-blue-500 px-4 py-2 rounded hover:bg-blue-600"
                    >
                      Suivre ({game.min_bet - playerPosition?.current_bet})
                    </button>
                  )}

                  <div className="flex items-center space-x-2">
                    <input
                      type="number"
                      value={raiseAmount}
                      onChange={(e) => setRaiseAmount(Number(e.target.value))}
                      className="w-20 px-2 py-1 text-black rounded"
                      min={game.min_bet * 2}
                      max={playerPosition?.stack}
                    />
                    <button
                      onClick={() => handleAction("raise", raiseAmount)}
                      className="bg-green-500 px-4 py-2 rounded hover:bg-green-600"
                      disabled={raiseAmount < game.min_bet * 2}
                    >
                      Relancer
                    </button>
                  </div>

                  <button
                    onClick={() => handleAction("all-in")}
                    className="bg-purple-500 px-4 py-2 rounded hover:bg-purple-600"
                  >
                    Tapis
                  </button>
                </div>
              )}

              {/* Informations du joueur */}
              <div className="text-center space-y-2">
                <div>Vos jetons: {playerPosition?.stack}</div>
                <div>Mise actuelle: {playerPosition?.current_bet}</div>
                <div>Mise minimum: {game.min_bet}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default MainComponent;