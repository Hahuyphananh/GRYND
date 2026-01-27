"use client";

import NavigationBar from "../../../../components/navigation-bar";
import React, { useState, useRef, useEffect } from "react";
import Link from "next/link";

// 🍓 Fruit → 💎 Luxury Gem Set
// 🌌 Fruit → 🚀 Galaxy Relics
const FRUIT_TO_SPACE: Record<string, string> = {
  // Common
  "🍉": "⭐",   // Star
  "🍌": "🌟",   // Bright Star
  "🍍": "🪐",   // Ringed Planet
  "🍏": "🌍",   // Earth-like World
  "🍓": "🌙",   // Moon

  // Mid-tier
  "🥭": "☄️",   // Comet
  "🍈": "🌑",   // Dark Moon
  "🍇": "🛸",   // UFO
  "🍒": "🚀",   // Rocket
  "🍎": "🌠",   // Shooting Star

  // Upper tier
  "🍊": "🌌",   // Galaxy
  "🍋": "🌀",   // Wormhole
  "🥝": "🛰️",   // Satellite
  "🍐": "🧭",   // Cosmic Navigator

  // Ultra-rare
  "🍑": "👽",   // Alien Entity
  "🥥": "🪐",   // Ancient Planet
  "🍅": "🌌",   // Deep Space
  "🍆": "🌀",   // Singularity
  "🌽": "🛸",   // Mothership
  "🍠": "🚀",   // Hyperdrive Ship
};

const glowBySpace: Record<string, string> = {
  "⭐": "shadow-yellow-300",
  "🌟": "shadow-yellow-400",
  "🌙": "shadow-slate-300",
  "🌍": "shadow-blue-400",
  "🪐": "shadow-indigo-400",

  "☄️": "shadow-orange-400",
  "🌑": "shadow-gray-500",
  "🚀": "shadow-red-500",
  "🛸": "shadow-cyan-400",
  "🌠": "shadow-purple-400",

  "🌌": "shadow-fuchsia-500",
  "🌀": "shadow-indigo-600",
  "🛰️": "shadow-sky-400",
  "🧭": "shadow-amber-400",

  "👽": "shadow-green-500",
};

const playSound = (freq = 880) => {
  const ctx = new ((window as any).AudioContext || (window as any).webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
};

export default function GemSlotMachine() {
  const [reels, setReels] = useState(Array.from({ length: 5 }, () => Array(3).fill("💎")));
  const [balance, setBalance] = useState(0);
  const [bet, setBet] = useState(100);
  const [lastResult, setLastResult] = useState("");
  const [totalWin, setTotalWin] = useState(0);
  const [totalLoss, setTotalLoss] = useState(0);
  const [autoSpinning, setAutoSpinning] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [flashWin, setFlashWin] = useState(false);
  const [winningPositions, setWinningPositions] = useState<{ col: number; row: number }[]>([]);
  const autoSpinRef = useRef<NodeJS.Timeout | null>(null);
  const [animatingReels, setAnimatingReels] = useState(Array(5).fill(false));

  useEffect(() => {
    const fetchTokens = async () => {
      try {
        const res = await fetch("/api/get-user-tokens", { method: "POST" });
        const data = await res.json();
        if (data.success) setBalance(parseFloat(data.data.balance));
      } catch {
        setLastResult("❌ Failed to load balance");
      }
    };
    fetchTokens();
  }, []);

  const handleBetChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value);
    if (!isNaN(value) && value > 0) setBet(Math.min(value, balance));
  };

  const handleSpin = async () => {
    if (balance < bet) {
      setLastResult("❌ Not enough balance.");
      return;
    }

    setSpinning(true);
    setAnimatingReels(Array(5).fill(true));

    try {
      const res = await fetch("/api/slots/play", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bet }),
      });

      const json = await res.json();
      if (!json.success) throw new Error(json.error);

      const { reels: newReels, winAmount, newBalance, winningLine } = json.data;

      await fetch("/api/slots/save-game", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ betAmount: bet, payout: winAmount, reels: newReels.flat() }),
      });

      setTimeout(() => {
        setAnimatingReels(Array(5).fill(false));
        setReels(newReels);

        playSound(winAmount >= bet * 5 ? 1200 : winAmount >= bet * 2 ? 1000 : 700);

       // 💥 Flash + highlight winning positions (persist until next spin)
if (winAmount > 0 && winningLine?.positions) {
  setWinningPositions(winningLine.positions);
  setFlashWin(true);
  setTimeout(() => setFlashWin(false), 800); // only the flash animation resets
} else {
  setWinningPositions([]); // clear highlights if no win
}


        setLastResult(
          winAmount >= bet * 5
            ? "💎 MEGA JACKPOT!"
            : winAmount >= bet * 2
            ? "✨ GEM MATCH!"
            : "❌ No match."
        );

        setBalance(newBalance);
        const safeWinAmount = Number(winAmount) || 0;
        setTotalWin((prev) => prev + safeWinAmount);
        if (safeWinAmount === 0) setTotalLoss((prev) => prev + bet);

        setSpinning(false);
      }, 1500);
    } catch {
      setLastResult("❌ Error playing slot");
      setSpinning(false);
    }
  };

  const startAutoSpin = () => {
    if (autoSpinning) return;
    setAutoSpinning(true);
    autoSpinRef.current = setInterval(handleSpin, 2000);
  };

  const stopAutoSpin = () => {
    setAutoSpinning(false);
    if (autoSpinRef.current) clearInterval(autoSpinRef.current);
  };

  const setMaxBet = () => setBet(Math.min(1000, balance));

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-[#001A33] to-[#002B5B] p-4 text-white relative">
      <NavigationBar currentPath="/slots/gems" />

      {/* Title */}
      <h1 className="text-4xl font-extrabold text-indigo-300 mb-6 drop-shadow-[0_0_15px_rgba(99,102,241,0.9)] animate-pulse mt-20">
        🌌 GALAXY SLOTS 🌌
      </h1>

      <Link href="/casino/slots">
        <button className="mb-6 flex items-center gap-2 bg-[#002B5B] border-2 border-yellow-400 text-yellow-300 font-semibold px-5 py-2 rounded-full shadow-[0_0_10px_rgba(255,215,0,0.4)] hover:bg-[#003F7A] hover:shadow-[0_0_16px_rgba(255,215,0,0.8)] transition">
          ⬅️ Return to Lobby
        </button>
      </Link>

      {/* Slot Frame */}
      <div className="relative flex border-8 border-yellow-500 rounded-2xl bg-[#003366] p-4 mb-6 shadow-[0_0_30px_gold] overflow-hidden">
        {flashWin && <div className="absolute inset-0 bg-yellow-400 bg-opacity-30 animate-flash pointer-events-none"></div>}

        {reels.map((column, colIdx) => {
          const symbols = animatingReels[colIdx] ? [...column, ...column, ...column] : column;

          return (
            <div key={colIdx} className="flex flex-col items-center mx-1 bg-[#002B5B] p-2 rounded-lg border-4 border-yellow-400 shadow-lg overflow-hidden h-[240px]">
              <div className={`flex flex-col ${animatingReels[colIdx] ? "animate-[scrollReel_0.3s_linear_infinite]" : ""}`}>
                {symbols.map((symbol, rowIdx) => {
                  const spaceSymbol = FRUIT_TO_SPACE[symbol] ?? "⭐";
                  const isWinning = winningPositions.some(p => p.col === colIdx && p.row === rowIdx);

                  return (
                    <div
                      key={`${symbol}-${colIdx}-${rowIdx}`}
                      className={`
                        w-16 h-16 text-4xl flex items-center justify-center my-1 rounded-xl border transition-all duration-300
                        ${isWinning
                          ? "bg-yellow-400 border-yellow-500 shadow-[0_0_25px_gold] animate-pulse scale-110 z-10"
                          : "bg-gradient-to-br from-[#020617] via-[#020617] to-[#020617] border-indigo-400 drop-shadow-[0_0_12px_rgba(99,102,241,0.6)]"}
                        ${glowBySpace[spaceSymbol]}
                      `}
                    >
                      {spaceSymbol}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Buttons */}
      <div className="flex items-center gap-4 mb-6">
        <button
          onClick={handleSpin}
          disabled={spinning}
          className="bg-yellow-400 hover:bg-yellow-500 text-black text-xl font-bold py-3 px-8 rounded-full shadow-lg transition animate-pulse disabled:opacity-50"
        >
          SPIN
        </button>

        {!autoSpinning ? (
          <button onClick={startAutoSpin} className="bg-red-500 hover:bg-red-600 text-white font-semibold py-2 px-6 rounded shadow">
            AUTO SPIN
          </button>
        ) : (
          <button onClick={stopAutoSpin} className="bg-red-700 hover:bg-red-800 text-white font-semibold py-2 px-6 rounded shadow">
            STOP AUTO
          </button>
        )}

        <button onClick={setMaxBet} className="bg-blue-500 hover:bg-blue-600 text-white font-semibold py-2 px-6 rounded shadow">
          MAX BET
        </button>
      </div>

      {/* Stats */}
      <div className="bg-black bg-opacity-40 p-6 rounded-lg w-full max-w-xl space-y-2 border-2 border-yellow-500">
        <div className="flex justify-between items-center">
          <span>Bet Amount:</span>
          <input type="number" min="1" max={balance} value={bet} onChange={handleBetChange} className="w-24 px-2 py-1 rounded text-black text-right" />
        </div>

        <div className="flex justify-between">
          <span>Balance:</span>
          <span className="font-bold text-green-400">${balance.toFixed(2)}</span>
        </div>

        <div className="flex justify-between">
          <span>Total Won:</span>
          <span className="font-bold text-green-300">${totalWin.toFixed(2)}</span>
        </div>

        <div className="flex justify-between">
          <span>Total Lost:</span>
          <span className="font-bold text-red-300">${totalLoss.toFixed(2)}</span>
        </div>

        <div className="text-center mt-4">
          {lastResult && <p className="text-xl">{lastResult}</p>}
        </div>
      </div>

      {/* Animations */}
      <style jsx>{`
        @keyframes scrollReel {
          0% { transform: translateY(0); }
          100% { transform: translateY(-33.33%); }
        }
        @keyframes flash {
          0%, 100% { opacity: 0; }
          50% { opacity: 1; }
        }
        .animate-flash {
          animation: flash 0.3s ease-in-out 4;
        }
      `}</style>
    </div>
  );
}
