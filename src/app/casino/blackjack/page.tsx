"use client";
import React, { useState, useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import NavigationBar from "../../../components/navigation-bar";
import { motion, AnimatePresence } from "framer-motion";
import BlackjackCardBack from "../../../components/BlackjackCardBack";

export default function BlackjackPage() {
  const { isSignedIn, user } = useUser();
  const router = useRouter();

  const [userTokens, setUserTokens] = useState<number | null>(null);
  const [gameState, setGameState] = useState("idle");
  const [bet, setBet] = useState(10);
  const [dealerCards, setDealerCards] = useState<any[]>([]);
  const [playerCards, setPlayerCards] = useState<any[]>([]);
  const [hands, setHands] = useState<any[][]>([]);
  const [activeHandIndex, setActiveHandIndex] = useState(0);
  const [isSplit, setIsSplit] = useState(false);
  const [canDouble, setCanDouble] = useState(false);
  const [canSplit, setCanSplit] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const PLACEHOLDER_CARDS = [0, 1];
  const [showRules, setShowRules] = useState(false);

  const fetchUserTokens = async () => {
    if (!user) return;
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const data = await response.json();
      if (data.success) setUserTokens(data.data.balance);
      else throw new Error(data.error || "Erreur inconnue");
    } catch {
      setError("Impossible de récupérer votre solde de tokens");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isSignedIn && user) fetchUserTokens();
  }, [isSignedIn, user]);

  const getRandomCard = () => {
    const suits = ["♠", "♥", "♦", "♣"];
    const values = [
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "J",
      "Q",
      "K",
      "A",
    ];
    return {
      suit: suits[Math.floor(Math.random() * suits.length)],
      value: values[Math.floor(Math.random() * values.length)],
    };
  };

  const calculateHandValue = (cards: any[]) => {
    let value = 0;
    let aces = 0;
    cards.forEach((card) => {
      if (card.value === "A") {
        aces += 1;
        value += 11;
      } else if (["K", "Q", "J"].includes(card.value)) value += 10;
      else value += parseInt(card.value);
    });
    while (value > 21 && aces > 0) {
      value -= 10;
      aces -= 1;
    }
    return value;
  };

  const startGame = async () => {
    if (!isSignedIn)
      return router.push("/sign-in?redirect_url=/casino/blackjack");
    if (userTokens! < bet) return setError("Solde insuffisant pour cette mise");

    try {
      await fetch("/api/blackjack/place-bet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: bet }),
      });

      const initialPlayerCards = [getRandomCard(), getRandomCard()];
      const dealerInit = [getRandomCard(), getRandomCard()];

      setPlayerCards(initialPlayerCards);
      setDealerCards(dealerInit);
      setGameState("playing");
      setMessage("");

      const sameValue =
        initialPlayerCards[0].value === initialPlayerCards[1].value;
      setCanDouble(userTokens! >= bet);
      setCanSplit(sameValue && userTokens! >= bet);

      if (calculateHandValue(initialPlayerCards) === 21) endGame("win");
      await fetchUserTokens();
    } catch {
      setError("Erreur lors du démarrage de la partie");
    }
  };

  const hit = () => {
    const newCard = getRandomCard();
    const newHand = [...playerCards, newCard];
    setPlayerCards(newHand);
    if (calculateHandValue(newHand) > 21) endGame("bust");
  };

  const stand = () => {
    let currentDealer = [...dealerCards];
    while (calculateHandValue(currentDealer) < 17) {
      currentDealer.push(getRandomCard());
    }
    setDealerCards(currentDealer);

    const playerValue = calculateHandValue(playerCards);
    const dealerValue = calculateHandValue(currentDealer);
    if (dealerValue > 21 || playerValue > dealerValue) endGame("win");
    else if (dealerValue > playerValue) endGame("lose");
    else endGame("push");
  };

  const doubleDown = async () => {
    if (userTokens! < bet)
      return setError("Pas assez de tokens pour doubler !");
    setBet((prev) => prev * 2);
    setCanDouble(false);
    const newCard = getRandomCard();
    const newHand = [...playerCards, newCard];
    setPlayerCards(newHand);

    if (calculateHandValue(newHand) > 21) endGame("bust");
    else stand();
  };

  const splitHand = () => {
    if (userTokens! < bet)
      return setError("Pas assez de tokens pour séparer !");
    if (playerCards.length !== 2) return;
    const [first, second] = playerCards;
    const newHands = [
      [first, getRandomCard()],
      [second, getRandomCard()],
    ];
    setHands(newHands);
    setActiveHandIndex(0);
    setIsSplit(true);
    setPlayerCards(newHands[0]);
    setCanSplit(false);
  };

  const nextSplitHand = () => {
    if (activeHandIndex === 0 && hands[1]) {
      setActiveHandIndex(1);
      setPlayerCards(hands[1]);
    } else {
      stand();
    }
  };

  const endGame = async (result: string) => {
    let winAmount = 0;
    let msg = "";
    let blackjack =
      playerCards.length === 2 && calculateHandValue(playerCards) === 21;

    switch (result) {
      case "win":
        winAmount = blackjack ? bet * 2.5 : bet * 2;
        msg = blackjack ? "Blackjack ! Vous avez gagné !" : "Vous avez gagné !";
        break;
      case "push":
        winAmount = bet;
        msg = "Égalité !";
        break;
      case "bust":
        msg = "Perdu ! Vous avez dépassé 21.";
        break;
      default:
        msg = "Perdu !";
        break;
    }

    try {
      await fetch("/api/blackjack/update-stats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          result,
          blackjack,
          amount: bet,
          payout: winAmount,
        }),
      });

      await fetchUserTokens();
    } catch {
      setError("Erreur à la fin de la partie");
    }

    if (result === "win") {
      const gain = winAmount - bet;
      msg += ` (+${gain} tokens)`;
    } else if (result === "push") {
      msg += ` (Vous récupérez votre mise de ${bet} tokens)`;
    } else {
      msg += ` (-${bet} tokens)`;
    }

    setMessage(msg);
    setGameState("finished");
    setIsSplit(false);
    setHands([]);
    setBet(10);
  };

  return (
    <div className="min-h-screen overflow-x-clip bg-[#030817] pb-24 pt-20 md:pb-8">
      <NavigationBar currentPath="/casino" />
      <div className="mx-auto max-w-4xl px-3 py-6 sm:px-4 sm:py-8">
        <div className="mb-4 flex flex-col gap-2 text-[#FFD700] sm:flex-row sm:justify-between">
          <h1 className="text-3xl font-bold">Blackjack</h1>
        </div>

        {error && (
          <div className="mb-4 bg-red-500/10 p-3 text-red-500 rounded">
            {error}
          </div>
        )}

        <div
          className="p-6 rounded-2xl border border-[#00e5ff]/40 
bg-gradient-to-br from-[#001933] via-[#00111f] to-[#000814]
shadow-[0_0_60px_rgba(0,229,255,0.35),inset_0_0_30px_rgba(0,229,255,0.1)]"
        >
          {/* Dealer */}
          <h2 className="text-[#FFD700] mb-2 text-center">Dealer</h2>
          {gameState !== "playing" && dealerCards.length > 0 && (
            <div className="text-[#FFD700] text-center mb-2">
              Points: {calculateHandValue(dealerCards)}
            </div>
          )}
          <div className="flex justify-center gap-4 mb-6">
            <AnimatePresence>
              {gameState === "idle"
                ? PLACEHOLDER_CARDS.map((_, i) => (
                    <motion.div
                      key={`dealer-placeholder-${i}`}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="h-28 w-20 rounded shadow"
                    >
                      <BlackjackCardBack />
                    </motion.div>
                  ))
                : dealerCards.map((card, i) => (
                    <motion.div
                      key={i}
                      initial={{ y: -50, opacity: 0 }}
                      animate={{ y: 0, opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.4, delay: i * 0.15 }}
                      className="h-28 w-20 bg-white text-xl flex items-center justify-center rounded shadow"
                      style={{
                        color: ["♥", "♦"].includes(card.suit) ? "red" : "black",
                      }}
                    >
                      {gameState === "playing" && i === 0 ? (
                        <BlackjackCardBack />
                      ) : (
                        `${card.value}${card.suit}`
                      )}
                    </motion.div>
                  ))}
            </AnimatePresence>
          </div>

          <div className="my-4 h-px bg-[#FFD700]/30"></div>

          {/* Player */}
          <h2 className="text-[#FFD700] mb-2 text-center">Vos cartes</h2>
          <div className="text-[#FFD700] text-center mb-2">
            Points: {calculateHandValue(playerCards)}
          </div>
          <div className="flex justify-center gap-4 mb-6">
            <AnimatePresence>
              {gameState === "idle"
                ? PLACEHOLDER_CARDS.map((_, i) => (
                    <motion.div
                      key={`player-placeholder-${i}`}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="h-28 w-20 rounded shadow"
                    >
                      <BlackjackCardBack />
                    </motion.div>
                  ))
                : playerCards.map((card, i) => (
                    <motion.div
                      key={i}
                      initial={{ y: 100, opacity: 0 }}
                      animate={{ y: 0, opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.4, delay: i * 0.15 }}
                      className="h-28 w-20 bg-white text-xl flex items-center justify-center rounded shadow"
                      style={{
                        color: ["♥", "♦"].includes(card.suit) ? "red" : "black",
                      }}
                    >
                      {`${card.value}${card.suit}`}
                    </motion.div>
                  ))}
            </AnimatePresence>
          </div>

          {message && (
            <div className="text-center text-xl text-[#FFD700] mb-4">
              {message}
            </div>
          )}

          {gameState === "idle" || gameState === "finished" ? (
            <div className="flex flex-col items-center space-y-4">
              <div className="flex flex-col items-center">
                <label className="text-[#FFD700] mb-2 text-lg font-semibold">
                  Entrez votre mise :
                </label>

                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min={1}
                    max={userTokens ?? 999999}
                    value={bet}
                    onChange={(e) =>
                      setBet(
                        Math.min(
                          Number(e.target.value),
                          userTokens ?? Number(e.target.value),
                        ),
                      )
                    }
                    className="text-center w-32 px-4 py-2 rounded-lg 
bg-[#00111f] text-[#d8fbff] 
border border-[#00e5ff]/40 
focus:outline-none focus:ring-2 focus:ring-[#00e5ff]/60
shadow-[inset_0_0_10px_rgba(0,229,255,0.2)]"
                  />

                  <button
                    onClick={() => {
                      if (userTokens)
                        setBet(Math.max(1, Math.floor(userTokens / 2)));
                    }}
                    className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/20 
px-6 py-2 text-[#d8fbff] font-semibold 
hover:bg-[#00e5ff]/35 active:scale-95 transition 
shadow-[0_0_12px_rgba(0,229,255,0.35)]"
                  >
                    ½
                  </button>

                  <button
                    onClick={() => {
                      if (userTokens) setBet(userTokens);
                    }}
                    className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/20 
px-6 py-2 text-[#d8fbff] font-semibold 
hover:bg-[#00e5ff]/35 active:scale-95 transition 
shadow-[0_0_12px_rgba(0,229,255,0.35)]"
                  >
                    ALL IN
                  </button>
                </div>

                {userTokens !== null && (
                  <p className="text-[#FFD700] mt-1 text-sm">
                    Solde disponible : {userTokens} tokens
                  </p>
                )}
              </div>

              <button
                onClick={startGame}
                className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/20 
  px-6 py-2 text-[#d8fbff] font-semibold 
  hover:bg-[#00e5ff]/35 active:scale-95 transition 
  shadow-[0_0_14px_rgba(0,229,255,0.4)] w-64 text-center"
              >
                Miser
              </button>
              <div className="flex justify-center mt-6">
                <button
                  onClick={() => setShowRules(!showRules)}
                  className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/20 
px-6 py-2 text-[#d8fbff] font-semibold 
hover:bg-[#00e5ff]/35 active:scale-95 transition 
shadow-[0_0_12px_rgba(0,229,255,0.35)] w-64"
                >
                  {showRules ? "Hide Rules ▲" : "Show Rules ▼"}
                </button>
              </div>

              {showRules && (
                <div
                  className="mt-4 w-full 
bg-[#00111f]/90 backdrop-blur-sm 
border border-[#00e5ff]/30 
rounded-xl p-6 text-[#d8fbff] 
shadow-[0_0_25px_rgba(0,229,255,0.2)]"
                >
                  <h2 className="text-2xl font-bold text-[#FFD700] mb-4 text-center">
                    Blackjack Rules
                  </h2>

                  <div className="space-y-4 text-sm leading-relaxed text-left">
                    <div>
                      <h3 className="text-[#FFD700] font-semibold">
                        🎯 Objective
                      </h3>
                      <p>
                        Beat the dealer by getting as close to 21 as possible
                        without going over.
                      </p>
                    </div>

                    <div>
                      <h3 className="text-[#FFD700] font-semibold">
                        🃏 Card Values
                      </h3>
                      <ul className="list-disc ml-5">
                        <li>2–10 = face value</li>
                        <li>J, Q, K = 10</li>
                        <li>Ace = 1 or 11</li>
                      </ul>
                    </div>

                    <div>
                      <h3 className="text-[#FFD700] font-semibold">
                        🎮 Gameplay
                      </h3>
                      <ul className="list-disc ml-5">
                        <li>You and dealer get 2 cards</li>
                        <li>One dealer card is hidden</li>
                        <li>Take actions to improve your hand</li>
                      </ul>
                    </div>

                    <div>
                      <h3 className="text-[#FFD700] font-semibold">
                        ⚡ Actions
                      </h3>
                      <ul className="list-disc ml-5">
                        <li>
                          <strong>Hit:</strong> Take a card
                        </li>
                        <li>
                          <strong>Stand:</strong> End your turn
                        </li>
                        <li>
                          <strong>Double:</strong> Double bet, take 1 card
                        </li>
                        <li>
                          <strong>Split:</strong> Split pairs into 2 hands
                        </li>
                      </ul>
                    </div>

                    <div>
                      <h3 className="text-[#FFD700] font-semibold">
                        🏆 Winning
                      </h3>
                      <ul className="list-disc ml-5">
                        <li>Get closer to 21 than dealer</li>
                        <li>Dealer busts ({">"}21)</li>
                        <li>Blackjack pays higher</li>
                      </ul>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="flex justify-center gap-4 mt-4 flex-wrap">
                <button
                  onClick={hit}
                  className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/20 
px-6 py-2 text-[#d8fbff] font-semibold 
hover:bg-[#00e5ff]/35 active:scale-95 transition 
shadow-[0_0_12px_rgba(0,229,255,0.35)]"
                >
                  Carte
                </button>
                <button
                  onClick={stand}
                  className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/20 
px-6 py-2 text-[#d8fbff] font-semibold 
hover:bg-[#00e5ff]/35 active:scale-95 transition 
shadow-[0_0_12px_rgba(0,229,255,0.35)]"
                >
                  Rester
                </button>
                {canDouble && (
                  <button
                    onClick={doubleDown}
                    className="rounded-lg border border-[#c084fc]/40 bg-[#c084fc]/20 
px-6 py-2 text-[#f5e9ff] font-semibold 
hover:bg-[#c084fc]/35 active:scale-95 transition 
shadow-[0_0_12px_rgba(192,132,252,0.4)]"
                  >
                    Double
                  </button>
                )}
                {canSplit && (
                  <button
                    onClick={splitHand}
                    className="rounded-lg border border-[#ff4df0]/40 bg-[#ff4df0]/20 
px-6 py-2 text-[#ffe6fb] font-semibold 
hover:bg-[#ff4df0]/35 active:scale-95 transition 
shadow-[0_0_12px_rgba(255,77,240,0.4)]"
                  >
                    Split
                  </button>
                )}
                {isSplit && (
                  <button
                    onClick={nextSplitHand}
                    className="rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/20 
px-6 py-2 text-[#d8fbff] font-semibold 
hover:bg-[#00e5ff]/35 active:scale-95 transition 
shadow-[0_0_12px_rgba(0,229,255,0.35)]"
                  >
                    Next Hand
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
