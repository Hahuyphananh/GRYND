"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import NavigationBar from "../../../components/navigation-bar";

const multiplierTable: Record<number, Record<number, number>> = {
  1: { 1: 3 },
  2: { 1: 1.5, 2: 6 },
  3: { 1: 1.2, 2: 3, 3: 12 },
  4: { 2: 2, 3: 6, 4: 20 },
  5: { 2: 2, 3: 5, 4: 15, 5: 50 },
};

export default function KenoGame() {
  const router = useRouter();
  const { isSignedIn, user } = useUser();

  const [betAmount, setBetAmount] = useState(100);
  const [selectedNumbers, setSelectedNumbers] = useState<number[]>([]);
  const [userBalance, setUserBalance] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [highlightedWins, setHighlightedWins] = useState<number[]>([]);
  const [animationDone, setAnimationDone] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showWinScreen, setShowWinScreen] = useState(false);

  const fetchUserBalance = async () => {
    if (!user) return;
    try {
      const res = await fetch("/api/get-user-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (data.success) setUserBalance(Number(data.data.balance));
      else setError("Failed to fetch balance");
    } catch {
      setError("Unable to fetch balance");
    }
  };

  useEffect(() => {
    if (isSignedIn) fetchUserBalance();
  }, [isSignedIn]);

  const toggleNumber = (num: number) => {
    if (highlightedWins.length > 0) {
      setHighlightedWins([]);
      setResult(null);
    }

    setSelectedNumbers((prev) =>
      prev.includes(num)
        ? prev.filter((n) => n !== num)
        : prev.length < 5
          ? [...prev, num]
          : prev,
    );
  };

  useEffect(() => {
    if (!result?.winningNumbers) return;

    setHighlightedWins([]);
    setAnimationDone(false);

    let i = 0;
    const interval = setInterval(() => {
      if (i >= result.winningNumbers.length) {
        clearInterval(interval);
        setAnimationDone(true);

        if (result.payout > 0) {
          setTimeout(() => setShowWinScreen(true), 400);
        }

        return;
      }
      setHighlightedWins((prev) => [...prev, result.winningNumbers[i]]);
      i++;
    }, 300);

    return () => clearInterval(interval);
  }, [result]);

  const handleAutoPick = () => {
    const picks: number[] = [];
    while (picks.length < 5) {
      const rand = Math.floor(Math.random() * 40) + 1;
      if (!picks.includes(rand)) picks.push(rand);
    }
    setSelectedNumbers(picks);
  };

  const handleClear = () => {
    setSelectedNumbers([]);
    setHighlightedWins([]);
    setResult(null);
    setAnimationDone(false);
  };

  const handleBet = async () => {
    setError(null);

    if (!isSignedIn) {
      router.push("/sign-in?redirect_url=/casino/keno");
      return;
    }
    if (betAmount <= 0) return setError("Bet must be more than 0");
    if (selectedNumbers.length < 1) return setError("Select at least 1 number");
    if (userBalance !== null && betAmount > userBalance)
      return setError("Not enough balance");

    setLoading(true);
    try {
      const res = await fetch("/api/keno/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ betAmount, numbers: selectedNumbers }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setLoading(false);
        return;
      }
      setResult(data);
      await fetchUserBalance();
    } catch {
      setError("Error starting game");
    }
    setLoading(false);
  };

  const payoutTable = multiplierTable[selectedNumbers.length] || {};

  return (
    <div className="relative flex min-h-screen flex-col items-center overflow-x-clip bg-gradient-to-br from-[#001933] to-[#000d1a] px-3 pb-24 pt-20 text-white sm:px-6 md:pb-8">
      <NavigationBar currentPath="/casino" />

      <div className="absolute right-3 top-24 rounded-lg border border-[#00e5ff]/30 bg-[#0b224f]/90 px-3 py-2 text-sm font-bold text-[#FFD700] shadow-[0_0_12px_rgba(0,229,255,0.2)] sm:right-4 sm:text-base">
        🪙 Balance: {userBalance ?? "..."}
      </div>

      <h1
        className="text-3xl font-extrabold tracking-wider text-transparent bg-clip-text 
               bg-gradient-to-r from-[#00e5ff] to-[#00ffa6] mt-20 mb-6"
      >
        ⚡ KENO
      </h1>

      {error && (
        <div className="bg-red-500/20 text-red-300 px-4 py-2 rounded mb-4">
          {error}
        </div>
      )}

      <div
        className="bg-[#050d1f]/80 backdrop-blur-xl border border-[#00e5ff]/40 
                shadow-[0_0_25px_rgba(0,229,255,0.25),inset_0_0_25px_rgba(0,229,255,0.08)]
                p-5 rounded-2xl flex flex-wrap gap-4 items-end mb-6"
      >
        {/* Bet Input */}
        <div className="flex flex-col gap-1">
          <label className="text-sm text-gray-300">Bet Amount</label>
          <input
            type="number"
            min={1}
            value={betAmount}
            onChange={(e) => setBetAmount(Number(e.target.value))}
            className="bg-[#020617] border border-[#00e5ff]/30 
                 focus:border-[#00e5ff] focus:shadow-[0_0_15px_rgba(0,229,255,0.6)]
                 rounded-xl px-3 py-3 text-white outline-none transition-all duration-300 w-28"
          />
        </div>

        <button
          onClick={handleBet}
          disabled={loading}
          className={`py-3 px-8 rounded-xl font-bold text-lg transition-all duration-300
  ${
    loading
      ? "bg-[#1a2333] text-gray-400 border border-gray-600"
      : "bg-gradient-to-r from-[#a855f7] to-[#ff4fd8] text-[#001933] border border-[#ff4fd8] shadow-[0_0_20px_#ff4fd8] hover:shadow-[0_0_35px_#a855f7] hover:scale-105"
  }
`}
        >
          {loading ? "Playing..." : "Bet"}
        </button>

        {/* Auto Pick */}
        <button
          onClick={handleAutoPick}
          className="px-5 py-3 rounded-xl font-bold transition-all duration-300
               bg-gradient-to-r from-[#00e5ff] to-[#00ffa6] text-[#001933]
               border border-[#00e5ff]
               shadow-[0_0_20px_rgba(0,229,255,0.6)]
               hover:shadow-[0_0_35px_rgba(0,255,166,1)] hover:scale-105"
        >
          AUTO PICK
        </button>

        {/* Clear */}
        <button
          onClick={handleClear}
          className="px-5 py-3 rounded-xl font-bold transition-all duration-300
               bg-[#1a2333] text-gray-400 border border-gray-600
               hover:bg-[#2a3446] hover:text-white"
        >
          CLEAR
        </button>
      </div>

      {/* Gameboard */}
      <div className="mb-6 bg-[#0b224f]/85 border-2 border-[#00e5ff]/35 rounded-2xl shadow-[0_0_24px_rgba(0,229,255,0.2)] p-6">
        <div className="flex gap-6">
          {/* Number grid */}
          <div className="grid grid-cols-8 gap-4 flex-1">
            {Array.from({ length: 40 }, (_, i) => i + 1).map((num) => {
              const isSelected = selectedNumbers.includes(num);
              const isWinning = highlightedWins.includes(num);
              const isDisabled = !isSelected && selectedNumbers.length >= 5;
              const isMatch = isSelected && isWinning;

              return (
                <button
                  key={num}
                  onClick={() => toggleNumber(num)}
                  disabled={isDisabled}
                  className={`relative w-16 h-16 flex items-center justify-center rounded-xl text-lg font-bold transition-all duration-300 overflow-hidden

  ${
    isMatch
      ? "bg-[#00ffa6] text-[#001933] scale-110 ring-4 ring-[#00ffa6]/70 shadow-[0_0_30px_rgba(0,255,166,1)] animate-pulse"
      : isWinning
        ? "bg-[#00ffa6]/30 text-white"
        : isSelected
          ? "bg-[#00e5ff] text-[#001933] shadow-[0_0_20px_rgba(0,229,255,0.8)] scale-105"
          : isDisabled
            ? "bg-[#002244] opacity-40 cursor-not-allowed"
            : "bg-[#020617] border border-[#00e5ff]/30 hover:border-[#00e5ff] hover:shadow-[0_0_15px_rgba(0,229,255,0.6)]"
  }`}
                >
                  {num}

                  {/* 🔥 Glow trail */}
                  {isWinning && (
                    <span className="absolute inset-0 bg-gradient-to-r from-transparent via-[#00ffa6]/60 to-transparent animate-[slide_0.6s_linear]" />
                  )}

                  {isMatch && (
                    <span className="absolute top-1 right-1 text-xs">🔥</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Multiplier panel */}
          <div
            className="w-44 bg-[#020617]/80 backdrop-blur-xl border border-[#00e5ff]/40 
                rounded-xl p-4 flex flex-col gap-2
                shadow-[0_0_20px_rgba(0,229,255,0.2)] flex flex-col gap-2 shadow-[0_0_12px_rgba(0,229,255,0.15)]"
          >
            <h3
              className="text-center font-bold text-transparent bg-clip-text 
               bg-gradient-to-r from-[#00e5ff] to-[#00ffa6] mb-2"
            >
              Payouts
            </h3>

            {Object.entries(payoutTable).map(([hits, mult]) => {
              const isActive =
                animationDone && result?.matches?.length === Number(hits);

              return (
                <div
                  key={hits}
                  className={`flex justify-between px-2 py-1 rounded text-sm
                    ${
                      isActive
                        ? "bg-green-400 text-black font-bold"
                        : "bg-[#0d335f]"
                    }`}
                >
                  <span>
                    {hits} hit{hits !== "1" ? "s" : ""}
                  </span>
                  <span>x{mult}</span>
                </div>
              );
            })}

            {selectedNumbers.length === 0 && (
              <div className="text-xs text-gray-400 text-center mt-2">
                Select numbers
              </div>
            )}
          </div>
        </div>
      </div>

      {result && (
        <div
          className="mt-6 bg-[#050d1f]/80 backdrop-blur-xl border border-[#00e5ff]/40 
                p-4 rounded-xl 
                shadow-[0_0_20px_rgba(0,229,255,0.2)]"
        >
          <p>🎯 Winning Numbers: {result.winningNumbers.join(", ")}</p>
          <p>✅ Matches: {result.matches.length}</p>
          <p>💰 Payout: {result.payout} tokens</p>
        </div>
      )}
      {/* Game Rules (Collapsible) */}
      <div className="w-full max-w-4xl mt-6 bg-[#0b224f]/85 border-2 border-[#00e5ff]/35 rounded-xl p-4 shadow-[0_0_20px_rgba(0,229,255,0.15)]">
        <button
          onClick={() => setShowRules(!showRules)}
          className="w-full text-left text-[#FFD700] font-bold text-lg flex justify-between items-center"
        >
          📜 Game Rules
          <span>{showRules ? "▲" : "▼"}</span>
        </button>

        {showRules && (
          <div className="mt-4 text-sm leading-relaxed space-y-3 text-gray-200">
            <p>
              🎯 <strong>Objective:</strong> Pick numbers and match them with
              randomly drawn numbers to win rewards.
            </p>

            <p>
              🔢 <strong>How to Play:</strong>
              <br />• Select between <strong>1 to 5 numbers</strong> from the
              1–40 grid. • Choose your bet amount. • Click{" "}
              <strong>“Bet”</strong> to start the round.
            </p>

            <p>
              🎲 <strong>Draw:</strong> 20 random numbers are drawn each round.
            </p>

            <p>
              🏆 <strong>Winning:</strong>
              <br />• The more of your selected numbers that match the drawn
              numbers, the higher your payout. • Payout multipliers depend on
              how many numbers you picked and how many matched.
            </p>

            <p>
              ⚠️ <strong>Important:</strong>
              <br />• You must select at least 1 number to play. • Maximum of 5
              numbers can be selected. • You cannot bet more than your available
              balance.
            </p>

            <p>
              🎮 <strong>Auto Pick:</strong> Automatically selects random
              numbers for you.
            </p>

            <p>
              🔄 <strong>Clear Table:</strong> Resets your selected numbers and
              current round.
            </p>
          </div>
        )}
      </div>
      {showWinScreen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md">
          {/* Glow background */}
          <div className="absolute w-[400px] h-[400px] bg-[#00ffa6]/20 blur-3xl animate-pulse"></div>

          <div
            className="relative bg-[#050d1f]/90 border border-[#00e5ff]/40 
                    shadow-[0_0_40px_rgba(0,229,255,0.4)]
                    rounded-2xl p-8 text-center w-[320px]"
          >
            <h2
              className="text-2xl font-extrabold mb-4 text-transparent bg-clip-text 
                     bg-gradient-to-r from-[#00e5ff] to-[#00ffa6]"
            >
              🎉 YOU WON
            </h2>

            <p className="text-lg text-white mb-2">
              Matches:{" "}
              <span className="text-[#00ffa6] font-bold">
                {result?.matches.length}
              </span>
            </p>

            <p className="text-xl font-bold text-[#00e5ff] drop-shadow-[0_0_12px_rgba(0,229,255,0.8)] mb-6">
              +{result?.payout} TOKENS
            </p>

            <button
              onClick={() => setShowWinScreen(false)}
              className="w-full py-3 rounded-xl font-bold transition-all duration-300
                   bg-gradient-to-r from-[#00e5ff] to-[#00ffa6] text-[#001933]
                   border border-[#00e5ff]
                   shadow-[0_0_20px_rgba(0,229,255,0.6)]
                   hover:shadow-[0_0_35px_rgba(0,255,166,1)] hover:scale-105"
            >
              CONTINUE
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
