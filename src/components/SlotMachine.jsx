"use client";
import React, { useState, useRef } from "react";

// 🎵 Optional: simple browser beep generator
const playSound = (freq = 880) => {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
};

const fruitIcons = [
  "🍉", "🍌", "🍍", "🍏", "🍓", "🥭", "🍈", "🍇", "🍒", "🍎",
  "🍊", "🍋", "🥝", "🍐", "🍑", "🥥", "🍅", "🍆", "🌽", "🍠"
];

const getRandomFruit = () => {
  const index = Math.floor(Math.random() * fruitIcons.length);
  return fruitIcons[index];
};

const SlotMachine = () => {
  const [reels, setReels] = useState(
    Array.from({ length: 5 }, () => Array(3).fill("💰"))
  );
  const [balance, setBalance] = useState(1000);
  const [bet, setBet] = useState(100);
  const [lastResult, setLastResult] = useState("");
  const [totalWin, setTotalWin] = useState(0);
  const [totalLoss, setTotalLoss] = useState(0);
  const [autoSpinning, setAutoSpinning] = useState(false);
  const autoSpinRef = useRef(null);

  const spin = () => {
    if (balance < bet) {
      setLastResult("❌ Not enough balance.");
      return;
    }

    const newReels = Array.from({ length: 5 }, () =>
      Array.from({ length: 3 }, () => getRandomFruit())
    );
    setReels(newReels);
    playSound(700); // Sound on spin

    const allSymbols = newReels.flat();
    const symbolCounts = {};
    allSymbols.forEach(symbol => {
      symbolCounts[symbol] = (symbolCounts[symbol] || 0) + 1;
    });

    const maxCount = Math.max(...Object.values(symbolCounts));
    let winnings = 0;

    if (maxCount >= 5) {
      winnings = bet * 5;
      setLastResult("🎉 JACKPOT! You won 5x your bet.");
      playSound(1200); // Big win sound
    } else if (maxCount >= 3) {
      winnings = bet * 2;
      setLastResult("✅ Match! You won 2x your bet.");
      playSound(1000); // Small win sound
    } else {
      setLastResult("❌ No match. You lost.");
    }

    const newBalance = balance - bet + winnings;
    setBalance(newBalance);
    setTotalWin(prev => prev + winnings);
    if (winnings === 0) setTotalLoss(prev => prev + bet);
  };

  const startAutoSpin = () => {
    if (autoSpinning) return;
    setAutoSpinning(true);
    autoSpinRef.current = setInterval(spin, 1000);
  };

  const stopAutoSpin = () => {
    setAutoSpinning(false);
    clearInterval(autoSpinRef.current);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-purple-900 to-indigo-900 p-4 text-white">
      {/* Reels */}
      <div className="flex border-8 border-yellow-400 rounded-xl bg-purple-700 p-4 mb-6">
        {reels.map((column, colIdx) => (
          <div
            key={colIdx}
            className="flex flex-col items-center mx-1 bg-purple-900 p-2 rounded-lg"
          >
         {column.map((fruit, rowIdx) => (
  <div
    key={`${fruit}-${Date.now()}-${rowIdx}`} // triggers re-animation on each spin
    className="w-16 h-16 text-4xl flex items-center justify-center my-1 bg-purple-800 rounded animate-spinReel"
    style={{ animationDelay: `${colIdx * 0.05}s` }}
  >
    {fruit}
  </div>
))}

          </div>
        ))}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-4 mb-6">
        <button
          onClick={spin}
          className="bg-red-500 hover:bg-red-600 text-white text-xl font-bold py-3 px-8 rounded-full shadow-lg transition"
        >
          SPIN
        </button>
        {!autoSpinning ? (
          <button
            onClick={startAutoSpin}
            className="bg-yellow-500 hover:bg-yellow-600 text-white font-semibold py-2 px-6 rounded shadow"
          >
            AUTO SPIN
          </button>
        ) : (
          <button
            onClick={stopAutoSpin}
            className="bg-yellow-700 hover:bg-yellow-800 text-white font-semibold py-2 px-6 rounded shadow"
          >
            STOP AUTO
          </button>
        )}
        <button
          onClick={() => setBet(prev => (prev + 100 <= balance ? prev + 100 : prev))}
          className="bg-blue-500 hover:bg-blue-600 text-white font-semibold py-2 px-6 rounded shadow"
        >
          MAX BET
        </button>
      </div>

      {/* Bet Panel */}
      <div className="bg-black bg-opacity-30 p-6 rounded-lg w-full max-w-xl text-white space-y-2">
        <div className="flex justify-between">
          <span>Balance:</span>
          <span className="font-bold text-green-400">${balance.toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span>Bet:</span>
          <span className="font-bold text-yellow-300">${bet}</span>
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
    </div>
  );
};

export default SlotMachine;
