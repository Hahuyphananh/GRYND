"use client";

import React, { useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import NavigationBar from "../../../components/navigation-bar";
import BlackjackCardBack from "../../../components/BlackjackCardBack";

export default function PokerPage() {
  const { user } = useUser();
  const router = useRouter();

  const [userTokens, setUserTokens] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [game, setGame] = useState(null);
  const [raiseAmount, setRaiseAmount] = useState(0);
  const [result, setResult] = useState(null);
  const [stats, setStats] = useState({
    biggestWin: 0,
    totalHands: 0,
    totalWins: 0,
  });
  const [opponentHand, setOpponentHand] = useState([]);
  const [playerHand, setPlayerHand] = useState([]);
  const [pot, setPot] = useState(0);
  const [betAmount, setBetAmount] = useState(10); // new state for bet input

  // --- SAME CARD GENERATOR AS BLACKJACK ---
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

  useEffect(() => {
    fetchTokens();
  }, []);

  const fetchTokens = async () => {
    try {
      const res = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
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

  const initializeAiGame = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch("/api/initialize-poker-vs-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ betAmount }),
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        setError(data.error || "Erreur lors de l'initialisation contre l'IA");
        return;
      }

      setGame({ id: data.data.gameId });

      // --- Use full 5-card hands from backend ---
      const playerCards = data.data.playerHand; // real player cards
      const aiCards = data.data.aiHand.map(() => ({ value: "?", suit: "?" })); // hidden AI cards

      setPlayerHand(playerCards);
      setOpponentHand(aiCards); // show ? for AI initially
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

        // Map AI hand suits to symbols
        const suitSymbols = {
          hearts: "♥",
          diamonds: "♦",
          clubs: "♣",
          spades: "♠",
        };
        const revealedAiHand = data.game.aiHand.map((c) => ({
          value: c.value,
          suit: suitSymbols[c.suit] || c.suit, // convert suit to symbol
        }));

        setOpponentHand(revealedAiHand);
      }

      // --- Update token balance immediately ---
      if (data.newBalance !== undefined) {
        setUserTokens(data.newBalance);
      }
    } catch (e) {
      console.error("Error in handleAction:", e);
      setError(e.message);
    }
  };

  // Evaluates a 5-card hand and returns the hand name
  const evaluateHand = (hand) => {
    if (!hand || hand.length !== 5) return "";

    const valuesOrder = {
      2: 2,
      3: 3,
      4: 4,
      5: 5,
      6: 6,
      7: 7,
      8: 8,
      9: 9,
      10: 10,
      J: 11,
      Q: 12,
      K: 13,
      A: 14,
    };
    const valueCounts = {};
    const suits = hand.map((c) => c.suit);
    const valueNums = hand
      .map((c) => valuesOrder[c.value])
      .sort((a, b) => a - b);

    hand.forEach(
      (c) => (valueCounts[c.value] = (valueCounts[c.value] || 0) + 1),
    );

    const counts = Object.values(valueCounts).sort((a, b) => b - a); // highest first
    const isFlush = new Set(suits).size === 1;
    const isStraight =
      valueNums.every((v, i) => i === 0 || v === valueNums[i - 1] + 1) ||
      valueNums.toString() === "2,3,4,5,14"; // Ace-low straight

    // Royal Flush
    if (isFlush && isStraight && Math.min(...valueNums) === 10)
      return "Royal Flush";
    if (isFlush && isStraight) return "Straight Flush";
    if (counts[0] === 4) return "Four of a Kind";
    if (counts[0] === 3 && counts[1] === 2) return "Full House";
    if (isFlush) return "Flush";
    if (isStraight) return "Straight";
    if (counts[0] === 3) return "Three of a Kind";
    if (counts[0] === 2 && counts[1] === 2) return "Two Pair";
    if (counts[0] === 2) return "One Pair";
    return "High Card";
  };

  const renderCard = (card, i, highlight = { values: [], color: "yellow" }) => {
    // 🂠 Hidden AI card → show Blackjack back
    if (card.value === "?") {
      return (
        <div key={i}>
          <BlackjackCardBack />
        </div>
      );
    }

    const suitSymbols = { hearts: "♥", diamonds: "♦", clubs: "♣", spades: "♠" };
    const symbol = suitSymbols[card.suit] || card.suit;
    const isHighlighted = highlight.values.includes(card.value);

    return (
      <div
        key={i}
        className={`h-20 w-14 sm:h-24 sm:w-16 md:h-28 md:w-20 bg-white text-lg flex items-center justify-center rounded shadow-[0_0_10px_rgba(255,255,255,0.2)] ${
          isHighlighted ? "border-4 border-yellow-500" : ""
        }`}
        style={{
          color: ["♥", "♦"].includes(symbol) ? "red" : "black",
        }}
      >
        {`${card.value}${symbol}`}
      </div>
    );
  };

  // highlight pairs/trips/quads; otherwise highlight highest card in YELLOW
  const getHighlightValues = (hand) => {
    if (!hand || hand.length === 0) return { values: [], color: "yellow" };

    // Ignore hidden AI cards
    const visibleHand = hand.filter((c) => c.value !== "?");
    if (visibleHand.length === 0) return { values: [], color: "yellow" };

    const valuesOrder = {
      2: 2,
      3: 3,
      4: 4,
      5: 5,
      6: 6,
      7: 7,
      8: 8,
      9: 9,
      10: 10,
      J: 11,
      Q: 12,
      K: 13,
      A: 14,
    };
    const valueCounts = {};
    visibleHand.forEach(
      (c) => (valueCounts[c.value] = (valueCounts[c.value] || 0) + 1),
    );

    // Highlight pairs/trips/quads
    const highlightPairs = Object.keys(valueCounts).filter(
      (v) => valueCounts[v] > 1,
    );
    if (highlightPairs.length > 0) {
      return { values: highlightPairs, color: "yellow" }; // use normal yellow, not lime
    }

    // Otherwise, highlight highest card
    const sorted = [...visibleHand].sort(
      (a, b) => valuesOrder[b.value] - valuesOrder[a.value],
    );
    return { values: [sorted[0].value], color: "yellow" };
  };

  return (
    <div className="min-h-screen overflow-x-clip bg-gradient-to-br from-[#020617] via-[#071A3A] to-[#0A2A5C] pb-24 pt-20 md:pb-8">
      <NavigationBar currentPath="/casino" />

      <div className="mx-auto max-w-4xl px-3 py-6 sm:px-4 sm:py-8">
        <h1 className="text-4xl font-bold text-[#00E5FF] text-center mb-6 drop-shadow-[0_0_12px_#00E5FF]">
          ♠️ Poker Royale
        </h1>
        <p className="text-lg font-semibold text-[#00E5FF] text-center drop-shadow-[0_0_8px_#00E5FF]">
          Tokens: {userTokens}
        </p>

        {error && (
          <div className="mb-4 mt-4 rounded bg-red-500/10 p-3 text-red-400 border border-red-500/30 shadow-[0_0_15px_rgba(255,0,0,0.3)]">
            {error}
          </div>
        )}

        {!game && (
          <div className="text-center mt-8">
            {/* --- Bet Amount Input --- */}
            <div className="flex justify-center items-center gap-2">
              <label className="text-[#00E5FF] font-semibold">
                Bet Amount:
              </label>
              <input
                type="number"
                value={betAmount}
                min="1"
                max={userTokens}
                onChange={(e) => setBetAmount(parseInt(e.target.value))}
                className="w-24 px-2 py-1 rounded bg-[#020617] border border-[#FFFF33]/30 text-white focus:border-[#FFFF33] focus:ring-1 focus:ring-[#FFFF33]"
              />
            </div>
            <div className="flex justify-center gap-4 mt-4 px-4">
              <button
                onClick={() => router.push("/casino/poker/multi")}
                className="flex-1 rounded-lg border border-[#FFFF33]/40 bg-[#FFFF33]/20 px-4 py-2 text-sm font-medium text-[#FFFF33] hover:bg-[#FFFF33]/35 transition"
              >
                Jouer au Texas Holdem ♦️
              </button>

              <button
                onClick={() => initializeAiGame(betAmount)}
                className="flex-1 rounded-lg border border-[#00e5ff]/40 bg-[#00e5ff]/20 px-4 py-2 text-sm font-medium text-[#d8fbff] hover:bg-[#00e5ff]/35 active:scale-95 transition"
              >
                Jouer aux mains ♠️
              </button>
            </div>
          </div>
        )}

        {game && (
          <div className="mx-auto mt-6 w-full max-w-6xl rounded-lg border border-[#FFFF33]/30 bg-[#020617] p-3 shadow-[0_0_30px_rgba(255,255,51,0.2)] backdrop-blur-md sm:mt-8 sm:p-6">
            {/* --- Result & Replay (Top of Board) --- */}
            {result && (
              <div className="mb-6 text-center space-y-3">
                <p className="text-xl font-bold text-[#FFFF33] drop-shadow-[0_0_10px_#FFFF33]">
                  {result.message}
                  {result.kicker && result.aiKicker && (
                    <span className="text-[#FFFF33] ml-2 text-sm">
                      (Kicker: {result.kicker} vs {result.aiKicker})
                    </span>
                  )}
                  {result.won && (
                    <span className="text-green-400 font-extrabold ml-2">
                      +{result.winAmount} tokens 🎉
                    </span>
                  )}
                </p>

                <button
                  onClick={() => {
                    setResult(null);
                    setGame(null);
                    initializeAiGame();
                  }}
                  className="bg-[#FFFF33]/20 hover:bg-[#FFFF33]/35 text-[#FFFF33] font-bold px-6 py-3 rounded-full text-sm sm:text-base border border-[#FFFF33]/40 shadow-[0_0_15px_rgba(255,255,51,0.5)]"
                >
                  🔄 Replay
                </button>
              </div>
            )}

            {/* --- Action Buttons (Below Result) --- */}
            <div className="flex flex-wrap justify-center items-center gap-4 mb-6">
              <button
                onClick={() => handleAction("fold")}
                className="bg-red-500/20 hover:bg-red-500/30 px-5 py-2 rounded-full font-bold text-red-300 border border-red-500/40 shadow-[0_0_10px_rgba(255,0,0,0.4)] text-sm sm:text-base"
              >
                Fold
              </button>
              <button
                onClick={() => {
                  setRaiseAmount((pot / 10) * 2);
                  handleAction("play");
                }}
                className="bg-green-500/20 hover:bg-green-500/30 px-5 py-2 rounded-full font-bold text-green-300 border border-green-500/40 shadow-[0_0_10px_rgba(0,255,0,0.4)] text-sm sm:text-base"
              >
                Play
              </button>
            </div>

            {/* --- Player & AI Hands --- */}
            <div className="flex justify-center flex-wrap gap-4 mb-4">
              {/* Player Hand */}
              <div>
                <h3 className="text-[#FFFF33] text-center mb-2">Votre main</h3>
                <div className="flex gap-2 justify-center">
                  {playerHand.map((c, i) =>
                    renderCard(c, i, getHighlightValues(playerHand)),
                  )}
                </div>
                {playerHand.length === 5 && (
                  <div className="text-center mt-2 text-lg font-bold text-[#FFFF33]">
                    Votre main: {evaluateHand(playerHand)}
                  </div>
                )}
              </div>

              {/* AI Hand */}
              <div>
                <h3 className="text-[#FFFF33] text-center mb-2">Main AI</h3>
                <div className="flex gap-2 justify-center">
                  {opponentHand.map((c, i) =>
                    renderCard(c, i, getHighlightValues(opponentHand)),
                  )}
                </div>
                {opponentHand.length === 5 &&
                  !opponentHand.some((c) => c.value === "?") && (
                    <div className="text-center mt-2 text-lg font-bold text-[#FFFF33]">
                      Main AI: {evaluateHand(opponentHand)}
                    </div>
                  )}
              </div>
            </div>

            {/* --- Pot Info --- */}
            <div className="text-center text-[#FFFF33] font-semibold text-lg drop-shadow-[0_0_8px_#FFFF33]">
              Pot actuel: {pot} tokens
            </div>
          </div>
        )}

        {/* Poker Hand Rankings Legend */}
        <div className="mt-6 w-full bg-[#020617] text-white p-4 rounded border border-[#FFFF33]/30 shadow-[0_0_20px_rgba(255,255,51,0.2)] backdrop-blur-md">
          <h3 className="text-[#FFFF33] font-bold mb-2 text-center drop-shadow-[0_0_8px_#FFFF33]">
            Poker Hands (Probabilities)
          </h3>
          <ul className="flex flex-wrap justify-center gap-6 text-sm">
            <li>Royal Flush (0.0001%)</li>
            <li>Straight Flush (0.001%)</li>
            <li>Four of a Kind (0.02%)</li>
            <li>Full House (0.1%)</li>
            <li>Flush (0.2%)</li>
            <li>Straight (0.4%)</li>
            <li>Three of a Kind (2.11%)</li>
            <li>Two Pair (4.75%)</li>
            <li>One Pair (42.26%)</li>
            <li>High Card (50.12%)</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
