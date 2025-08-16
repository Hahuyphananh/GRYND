"use client";
import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import NavigationBar from "../../../components/navigation-bar";

export default function RPSGame() {
  const [tokens, setTokens] = useState(0);
  const [betAmount, setBetAmount] = useState(10);
  const [playerChoice, setPlayerChoice] = useState<string | null>(null);
  const [aiChoice, setAiChoice] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [winStreak, setWinStreak] = useState(0);
  const [multiplier, setMultiplier] = useState(1.0);

  // AutoBet state
  const [autoBet, setAutoBet] = useState({
    enabled: false,
    mode: "finite" as "finite" | "infinite",
    spinsLeft: 0,
  });

  // Ref to access latest autoBet inside async functions
  const autoBetRef = useRef(autoBet);
  autoBetRef.current = autoBet;

  const choices = ["rock", "paper", "scissors"];
  const router = useRouter();

  useEffect(() => {
    fetch("/api/get-user-tokens", { method: "POST" })
      .then((res) => res.json())
      .then((data) => setTokens(data.data.balance))
      .catch(() => setTokens(0));
  }, []);

  // Updated multiplier: fixed 1.9× for any win streak > 0
  const calculateMultiplier = (streak: number) => {
    if (streak <= 0) return 1.0;
    return 1.9;
  };

  const winStreakRef = useRef(winStreak);
  winStreakRef.current = winStreak;

  const multiplierRef = useRef(multiplier);
  multiplierRef.current = multiplier;

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const placeBet = async () => {
  if (!playerChoice) {
    alert("Please choose Rock, Paper, or Scissors first!");
    if (autoBetRef.current.enabled) {
      setAutoBet((prev) => ({ ...prev, enabled: false }));
    }
    return;
  }
  if (betAmount <= 0 || betAmount > tokens) {
    alert("Invalid bet amount!");
    if (autoBetRef.current.enabled) {
      setAutoBet((prev) => ({ ...prev, enabled: false }));
    }
    return;
  }

  // Deduct tokens immediately on frontend for visual feedback
  setTokens((prev) => prev - betAmount);

  setLoading(true);
  setResult(null);
  setAiChoice(null);

  // Wait 1 second before calling API
  await delay(1000);

  const res = await fetch("/api/rps/play", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ betAmount, choice: playerChoice, winStreak: winStreakRef.current }),
  });

  const data = await res.json();

  // Update tokens to latest from backend (adjusted by backend)
  setTokens(data.newBalance);
  setAiChoice(data.aiChoice);
  setResult(data.result);

  if (data.result === "win") {
    const newStreak = winStreakRef.current + 1;
    setWinStreak(newStreak);
    winStreakRef.current = newStreak;
    const newMultiplier = calculateMultiplier(newStreak);
    setMultiplier(newMultiplier);
    multiplierRef.current = newMultiplier;
  } else if (data.result === "lose") {
    setWinStreak(0);
    winStreakRef.current = 0;
    setMultiplier(1.0);
    multiplierRef.current = 1.0;
  } else if (data.result === "tie") {
    // Tie: streak reset or keep? (You can decide)
    setWinStreak(0);
    winStreakRef.current = 0;
    setMultiplier(1.0);
    multiplierRef.current = 1.0;
  }

  setLoading(false);

    if (autoBetRef.current.enabled) {
      if (
        autoBetRef.current.mode === "finite" &&
        autoBetRef.current.spinsLeft <= 1
      ) {
        setAutoBet({ enabled: false, mode: "finite", spinsLeft: 0 });
      } else {
        if (autoBetRef.current.mode === "finite") {
          setAutoBet((prev) => ({
            ...prev,
            spinsLeft: prev.spinsLeft - 1,
          }));
        }
        setTimeout(() => {
          placeBet();
        }, 1500);
      }
    }
  };

  return (
    <div className="flex flex-col md:flex-row min-h-screen bg-gradient-to-br from-[#001933] to-[#000d1a] text-white">
       <NavigationBar currentPath="/casino" />

      {/* Left Sidebar */}
      <div className="w-full max-w-[380px] md:max-w-[380px] bg-[#002b55] rounded-xl p-6 flex flex-col gap-6 shadow-lg mx-auto md:mx-0 mb-6 md:mb-0">

        {/* Title */}
        <h1 className="text-3xl font-bold text-yellow-400 text-center whitespace-nowrap mt-20">
          ✊ Rock Paper Scissors
        </h1>

        {/* Tokens Display */}
        <p className="text-lg text-center md:text-left">Your Tokens: {tokens}</p>

        {/* Bet Amount Input */}
        <div className="flex items-center justify-center gap-2">
          <label htmlFor="betInput" className="font-semibold">
            Bet:
          </label>
          <input
            id="betInput"
            type="number"
            min={1}
            max={tokens}
            value={betAmount}
            onChange={(e) => setBetAmount(Number(e.target.value))}
            className="text-black rounded px-2 py-1 w-20 text-center"
          />
          <span>tokens</span>
        </div>

        {/* Place Bet Button */}
        <button
          onClick={placeBet}
          disabled={loading}
          className="bg-gradient-to-b from-yellow-400 to-yellow-600 text-black px-6 py-3 rounded-xl font-bold shadow-lg hover:from-yellow-300 hover:to-yellow-500 disabled:opacity-50"
        >
          {loading ? "Betting..." : "Place Bet"}
        </button>

        {/* AutoBet Feature */}
        <div className="mt-4 bg-[#001f3f] p-4 rounded-lg border border-yellow-400">
          <label className="flex items-center gap-2 font-semibold mb-2">
            <input
              type="checkbox"
              checked={autoBet.enabled}
              onChange={(e) => {
                if (
                  e.target.checked &&
                  (!playerChoice || betAmount <= 0 || betAmount > tokens)
                ) {
                  alert("Select a valid choice and bet amount before enabling AutoBet.");
                  return;
                }
                setAutoBet((prev) => ({
                  ...prev,
                  enabled: e.target.checked,
                }));
              }}
            />
            Auto Bet
          </label>

          {autoBet.enabled && (
            <>
              <div className="mb-2">
                <select
                  value={autoBet.mode}
                  onChange={(e) =>
                    setAutoBet((prev) => ({
                      ...prev,
                      mode: e.target.value as "finite" | "infinite",
                    }))
                  }
                  className="w-full rounded border border-yellow-400 bg-[#102542] px-2 py-1 text-center text-white"
                >
                  <option value="finite">Finite</option>
                  <option value="infinite">Infinite</option>
                </select>
              </div>
              {autoBet.mode === "finite" && (
                <input
                  type="number"
                  min={1}
                  value={autoBet.spinsLeft}
                  onChange={(e) =>
                    setAutoBet((prev) => ({
                      ...prev,
                      spinsLeft: Number(e.target.value),
                    }))
                  }
                  placeholder="Number of spins"
                  className="w-full rounded border border-yellow-400 bg-[#102542] px-2 py-1 text-center text-white"
                />
              )}
              <button
                onClick={() =>
                  setAutoBet({ enabled: false, mode: "finite", spinsLeft: 0 })
                }
                className="mt-2 w-full bg-red-600 hover:bg-red-700 text-white font-bold rounded px-4 py-2"
              >
                Stop AutoBet
              </button>
            </>
          )}
        </div>
      </div>

      {/* Right Main Panel */}
      <main className="flex-1 flex flex-col items-center justify-center gap-8 ml-0 md:ml-6 w-full max-w-full md:max-w-none px-4 md:px-0">
        {/* Game board */}
        <div className="flex flex-col md:flex-row items-center gap-12">
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
            className={`text-2xl font-bold ${
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
        <div className="flex gap-4 flex-wrap justify-center md:justify-start">
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

        {/* Win streak & multiplier */}
        <div className="text-center md:text-left w-full max-w-[400px] mx-auto md:mx-0">
          <p className="text-xl">
            <span className="text-yellow-400 font-bold">Win Streak:</span> {winStreak}
          </p>
          <p className="text-xl">
            <span className="text-yellow-400 font-bold">Multiplier:</span> {multiplier.toFixed(2)}×
          </p>
        </div>
      </main>
    </div>
  );
}

function getEmoji(choice: string | null) {
  switch (choice) {
    case "rock":
      return "✊";
    case "paper":
      return "✋";
    case "scissors":
      return "✌️";
    default:
      return "❔";
  }
}
