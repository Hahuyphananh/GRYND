"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function RPSGame() {
  const [tokens, setTokens] = useState(0);
  const [betAmount, setBetAmount] = useState(10);
  const [playerChoice, setPlayerChoice] = useState<string | null>(null);
  const [aiChoice, setAiChoice] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [winStreak, setWinStreak] = useState(0); // Track consecutive wins
  const [multiplier, setMultiplier] = useState(1.0); // Dynamic multiplier

  const choices = ["rock", "paper", "scissors"];
  const router = useRouter();

  // Fetch user balance on load
  useEffect(() => {
    fetch("/api/get-user-tokens", { method: "POST" })
      .then((res) => res.json())
      .then((data) => setTokens(data.data.balance))
      .catch(() => setTokens(0));
  }, []);

  // Calculate multiplier (Stake style, doubles each win)
  const calculateMultiplier = (streak: number) => {
    if (streak <= 0) return 1.0;
    return Math.pow(1.96, streak); // base multiplier from your odds
  };

  const placeBet = async () => {
    if (!playerChoice) {
      alert("Please choose Rock, Paper, or Scissors first!");
      return;
    }
    if (betAmount <= 0 || betAmount > tokens) {
      alert("Invalid bet amount!");
      return;
    }

    setLoading(true);
    setResult(null);
    setAiChoice(null);

    const res = await fetch("/api/rps/play", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ betAmount, choice: playerChoice, winStreak }),
    });

    const data = await res.json();
    setAiChoice(data.aiChoice);
    setResult(data.result);
    setTokens(data.newBalance);

    // Update streak
    if (data.result === "win") {
      const newStreak = winStreak + 1;
      setWinStreak(newStreak);
      setMultiplier(calculateMultiplier(newStreak));
    } else if (data.result === "lose") {
      setWinStreak(0);
      setMultiplier(1.0);
    }

    setLoading(false);
  };

  const getEmoji = (choice: string | null) => {
    switch (choice) {
      case "rock": return "✊";
      case "paper": return "✋";
      case "scissors": return "✌️";
      default: return "❔";
    }
  };

  return (
    <div className="relative min-h-screen bg-gradient-to-br from-[#001933] to-[#000d1a] text-white flex flex-col items-center justify-center p-6">

      {/* ✅ Return to Casino Button */}
      <button
        onClick={() => router.push("/casino")}
        className="absolute top-4 left-4 bg-gray-700 hover:bg-gray-800 text-white px-4 py-2 rounded shadow"
      >
        ⬅ Return to Casino
      </button>

      <h1 className="text-4xl font-bold mb-4 text-yellow-400">✊ Rock Paper Scissors</h1>
      <p className="mb-2 text-lg">Your Tokens: {tokens}</p>

      <div className="flex items-center gap-2 mb-6">
        <span>Bet:</span>
        <input
          type="number"
          value={betAmount}
          onChange={(e) => setBetAmount(Number(e.target.value))}
          className="text-black px-2 py-1 rounded w-24"
        />
        <span>tokens</span>
      </div>

      {/* Game board */}
      <div className="flex flex-col md:flex-row items-center gap-12 mb-6">
        <div className="bg-[#002b55] border border-yellow-500 w-32 h-44 flex items-center justify-center rounded-xl shadow-xl text-6xl">
          {getEmoji(playerChoice)}
        </div>
        <div className="text-3xl font-bold text-yellow-400">VS</div>
        <div className="bg-[#002b55] border border-yellow-500 w-32 h-44 flex items-center justify-center rounded-xl shadow-xl text-6xl">
          {getEmoji(aiChoice)}
        </div>
      </div>

      {result && (
        <div
          className={`mb-6 text-2xl font-bold ${
            result === "win"
              ? "text-green-400"
              : result === "lose"
              ? "text-red-400"
              : "text-gray-400"
          }`}
        >
          {result.toUpperCase()}
        </div>
      )}

      {/* Choice buttons */}
      <div className="mt-4 flex gap-4">
        {choices.map((choice) => (
          <button
            key={choice}
            onClick={() => setPlayerChoice(choice)}
            className={`px-6 py-3 rounded-xl font-bold shadow-lg ${
              playerChoice === choice
                ? "bg-yellow-500 text-black"
                : "bg-yellow-700 hover:bg-yellow-600 text-black"
            }`}
          >
            {choice.charAt(0).toUpperCase() + choice.slice(1)}
          </button>
        ))}
      </div>

      {/* Bet button */}
      <button
        onClick={placeBet}
        disabled={loading}
        className="mt-6 bg-gradient-to-b from-yellow-400 to-yellow-600 text-black px-8 py-3 rounded-xl font-bold shadow-lg hover:from-yellow-300 hover:to-yellow-500 disabled:opacity-50"
      >
        {loading ? "Betting..." : "Place Bet"}
      </button>

      {/* ✅ Win streak & multiplier */}
      <div className="mt-4 text-center">
        <p className="text-xl">
          <span className="text-yellow-400 font-bold">Win Streak:</span> {winStreak}
        </p>
        <p className="text-xl">
          <span className="text-yellow-400 font-bold">Multiplier:</span> {multiplier.toFixed(2)}×
        </p>
      </div>
    </div>
  );
}
