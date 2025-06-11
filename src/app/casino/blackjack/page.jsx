"use client";
import React, { useState, useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";

export default function BlackjackPage() {
  const { isSignedIn, user } = useUser();
  const router = useRouter();

  const [userTokens, setUserTokens] = useState(null);
  const [gameState, setGameState] = useState("betting");
  const [bet, setBet] = useState(10);
  const [dealerCards, setDealerCards] = useState([]);
  const [playerCards, setPlayerCards] = useState([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchUserTokens = async () => {
    if (!user) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
      });

      const data = await response.json();
      if (data.success) {
        setUserTokens(data.data.balance);
      } else {
        throw new Error(data.error || "Erreur inconnue");
      }
    } catch (error) {
      console.error("Error fetching tokens:", error);
      setError("Impossible de récupérer votre solde de tokens");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isSignedIn && user) {
      fetchUserTokens();
    }
  }, [isSignedIn, user]);

  const getRandomCard = () => {
    const suits = ["♠", "♥", "♦", "♣"];
    const values = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
    return {
      suit: suits[Math.floor(Math.random() * suits.length)],
      value: values[Math.floor(Math.random() * values.length)],
    };
  };

  const calculateHandValue = (cards) => {
    let value = 0;
    let aces = 0;

    cards.forEach((card) => {
      if (card.value === "A") {
        aces += 1;
        value += 11;
      } else if (["K", "Q", "J"].includes(card.value)) {
        value += 10;
      } else {
        value += parseInt(card.value);
      }
    });

    while (value > 21 && aces > 0) {
      value -= 10;
      aces -= 1;
    }

    return value;
  };

  const startGame = async () => {
    if (!isSignedIn) {
      router.push("/sign-in?redirect_url=/casino/blackjack");
      return;
    }

    if (userTokens < bet) {
      setError("Solde insuffisant pour cette mise");
      return;
    }

    try {
      const betResponse = await fetch("/api/blackjack/place-bet", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ amount: bet }),
      });

      if (!betResponse.ok) throw new Error("Failed to place bet");

      const initialPlayerCards = [getRandomCard(), getRandomCard()];
      setPlayerCards(initialPlayerCards);
      setDealerCards([getRandomCard(), getRandomCard()]);

      if (calculateHandValue(initialPlayerCards) === 21) {
        endGame("win");
      } else {
        setGameState("playing");
        setMessage("");
      }

      await fetchUserTokens();
    } catch (error) {
      console.error("Error starting game:", error);
      setError("Erreur lors du démarrage de la partie");
    }
  };

  const hit = () => {
    const newCard = getRandomCard();
    const newHand = [...playerCards, newCard];
    setPlayerCards(newHand);

    if (calculateHandValue(newHand) > 21) {
      endGame("bust");
    }
  };

  const stand = () => {
    let currentDealerCards = [...dealerCards];
    while (calculateHandValue(currentDealerCards) < 17) {
      currentDealerCards.push(getRandomCard());
    }
    setDealerCards(currentDealerCards);

    const playerValue = calculateHandValue(playerCards);
    const dealerValue = calculateHandValue(currentDealerCards);

    if (dealerValue > 21 || playerValue > dealerValue) endGame("win");
    else if (dealerValue > playerValue) endGame("lose");
    else endGame("push");
  };

  const endGame = async (result) => {
    let winAmount = 0;
    let message = "";
    let won = false;
    let blackjack = false;

    if (playerCards.length === 2 && calculateHandValue(playerCards) === 21) {
      blackjack = true;
    }

    switch (result) {
      case "win":
        winAmount = blackjack ? bet * 2.5 : bet * 2;
        message = blackjack ? "Blackjack ! Vous avez gagné !" : "Vous avez gagné !";
        won = true;
        break;
      case "push":
        winAmount = bet;
        message = "Égalité !";
        break;
      case "bust":
        message = "Perdu ! Vous avez dépassé 21.";
        break;
      case "lose":
        message = "Perdu !";
        break;
    }

    try {
      await fetch("/api/update-blackjack-stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          won,
          blackjack,
          amount: bet,
          winAmount: winAmount > 0 ? winAmount - bet : 0,
        }),
      });

      if (winAmount > 0) {
        await fetch("/api/tokens/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount: winAmount }),
        });
        await fetchUserTokens();
      }
    } catch (err) {
      console.error("Error ending game:", err);
      setError("Une erreur est survenue lors de la fin de la partie");
    }

    setMessage(message);
    setGameState("betting");
  };

  return (
    <div className="min-h-screen bg-[#003366] pt-20">
      <div className="mx-auto max-w-4xl px-4 py-8">
        <div className="mb-8 flex items-center justify-between">
          <a href="/casino" className="text-[#FFD700]">
            Retour au Casino
          </a>
          <h1 className="text-4xl font-bold text-[#FFD700]">Blackjack</h1>
          <div className="flex items-center gap-2 text-[#FFD700]">
            <i className="fas fa-coins" />
            <span>{userTokens !== null ? userTokens : "..."}</span>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded bg-red-500/10 p-3 text-red-500">{error}</div>
        )}

        <div className="rounded-lg bg-[#0e6b0e] p-6 border-[10px] border-[#5c3b15] shadow-inner">
          <h2 className="text-xl text-[#FFD700] mb-4">Dealer</h2>
          <div className="flex justify-center gap-4 mb-4">
            {dealerCards.map((card, i) => (
              <div
                key={i}
                className="h-32 w-24 bg-white text-xl flex items-center justify-center rounded shadow"
                style={{
                  color: ["♥", "♦"].includes(card.suit) ? "red" : "black",
                }}
              >
                {gameState === "playing" && i === 0 ? "?" : `${card.value}${card.suit}`}
              </div>
            ))}
          </div>

          <h2 className="text-xl text-[#FFD700] mb-4">Vos cartes</h2>
          <div className="flex justify-center gap-4 mb-2">
            {playerCards.map((card, i) => (
              <div
                key={i}
                className="h-32 w-24 bg-white text-xl flex items-center justify-center rounded shadow"
                style={{
                  color: ["♥", "♦"].includes(card.suit) ? "red" : "black",
                }}
              >
                {`${card.value}${card.suit}`}
              </div>
            ))}
          </div>

          <div className="text-[#FFD700] text-lg mb-4">
            Points: {calculateHandValue(playerCards)}
            {playerCards.length === 2 && calculateHandValue(playerCards) === 21 && (
              <span className="ml-2 text-green-400">(Blackjack!)</span>
            )}
          </div>

          {message && (
            <div className="text-center text-xl text-[#FFD700] mb-4">{message}</div>
          )}

          {gameState === "betting" ? (
            <div className="flex flex-col items-center space-y-4">
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setBet(Math.max(10, bet - 10))}
                  className="bg-[#FFD700] px-4 py-2 rounded text-[#003366]"
                >
                  -
                </button>
                <span className="text-xl text-[#FFD700]">{bet}</span>
                <button
                  onClick={() => setBet(bet + 10)}
                  className="bg-[#FFD700] px-4 py-2 rounded text-[#003366]"
                >
                  +
                </button>
              </div>
              <button
                onClick={startGame}
                className="bg-[#FFD700] px-6 py-2 rounded text-[#003366] font-semibold"
              >
                Miser
              </button>
            </div>
          ) : (
            <div className="flex justify-center gap-4 mt-4">
              <button
                onClick={hit}
                className="bg-[#FFD700] px-6 py-2 rounded text-[#003366] font-semibold"
              >
                Carte
              </button>
              <button
                onClick={stand}
                className="bg-[#FFD700] px-6 py-2 rounded text-[#003366] font-semibold"
              >
                Rester
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
