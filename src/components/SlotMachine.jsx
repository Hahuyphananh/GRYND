"use client";
import NavigationBar from "../components/navigation-bar";
import React, { useState, useRef, useEffect } from "react";

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

export default function SlotMachine() {
  const [reels, setReels] = useState(
    Array.from({ length: 5 }, () => Array(3).fill("💰"))
  );
  const [balance, setBalance] = useState(0);
  const [bet, setBet] = useState(100);
  const [lastResult, setLastResult] = useState("");
  const [totalWin, setTotalWin] = useState(0);
  const [totalLoss, setTotalLoss] = useState(0);
  const [autoSpinning, setAutoSpinning] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [flashWin, setFlashWin] = useState(false);
  const autoSpinRef = useRef(null);

  const [animatingReels, setAnimatingReels] = useState(Array(5).fill(false));

  // Load token balance from backend
  useEffect(() => {
    const fetchTokens = async () => {
      try {
        const res = await fetch("/api/get-user-tokens", { method: "POST" });
        const data = await res.json();
        if (data.success) {
          setBalance(parseFloat(data.data.balance));
        }
      } catch (err) {
        console.error("Error fetching tokens:", err);
        setLastResult("❌ Failed to load balance");
      }
    };

    fetchTokens();
  }, []);

  const handleBetChange = (e) => {
    const value = parseInt(e.target.value);
    if (!isNaN(value) && value > 0) {
      setBet(Math.min(value, balance));
    }
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

      const { reels: newReels, winAmount, newBalance } = json.data;

      // Simulate spin time
      setTimeout(() => {
        setAnimatingReels(Array(5).fill(false));
        setReels(newReels);
        playSound(
          winAmount >= bet * 5 ? 1200 : winAmount >= bet * 2 ? 1000 : 700
        );

        if (winAmount > 0) {
          setFlashWin(true);
          setTimeout(() => setFlashWin(false), 800);
        }

        setLastResult(
          winAmount >= bet * 5
            ? "🎉 JACKPOT!"
            : winAmount >= bet * 2
            ? "✅ Match!"
            : "❌ No match."
        );

        setBalance(newBalance);
        setTotalWin((prev) => prev + winAmount);
        if (winAmount === 0) setTotalLoss((prev) => prev + bet);

        setSpinning(false);
      }, 1500);
    } catch (err) {
      console.error("Slot error:", err);
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
    clearInterval(autoSpinRef.current);
  };

  const setMaxBet = () => {
    setBet(Math.min(1000, balance)); // Max bet limit
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-[#001A33] to-[#002B5B] p-4 text-white relative">
      <NavigationBar currentPath="/casino" />
      {/* Title */}
      <h1 className="text-4xl font-extrabold text-yellow-400 mb-6 drop-shadow-[0_0_10px_gold] animate-pulse mt-20">
        🎰 FORTUNE SPIN SLOTS 🎰
      </h1>

      {/* Slot Frame */}
      <div className="relative flex border-8 border-yellow-500 rounded-2xl bg-[#003366] p-4 mb-6 shadow-[0_0_30px_gold] overflow-hidden">
        {flashWin && (
          <div className="absolute inset-0 bg-yellow-400 bg-opacity-30 animate-flash pointer-events-none"></div>
        )}

        {reels.map((column, colIdx) => {
          const symbols = animatingReels[colIdx]
            ? [...column, ...column, ...column]
            : column;

          return (
            <div
              key={colIdx}
              className="flex flex-col items-center mx-1 bg-[#002B5B] p-2 rounded-lg border-4 border-yellow-400 shadow-lg overflow-hidden h-[240px]"
            >
              <div
                className={`flex flex-col ${
                  animatingReels[colIdx]
                    ? "animate-[scrollReel_0.3s_linear_infinite]"
                    : ""
                }`}
              >
                {symbols.map((fruit, rowIdx) => (
                  <div
                    key={`${fruit}-${colIdx}-${rowIdx}`}
                    className="w-16 h-16 text-4xl flex items-center justify-center my-1 bg-[#004080] rounded-lg border-2 border-yellow-300"
                  >
                    {fruit}
                  </div>
                ))}
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
          <button
            onClick={startAutoSpin}
            className="bg-red-500 hover:bg-red-600 text-white font-semibold py-2 px-6 rounded shadow"
          >
            AUTO SPIN
          </button>
        ) : (
          <button
            onClick={stopAutoSpin}
            className="bg-red-700 hover:bg-red-800 text-white font-semibold py-2 px-6 rounded shadow"
          >
            STOP AUTO
          </button>
        )}
        <button
          onClick={setMaxBet}
          className="bg-blue-500 hover:bg-blue-600 text-white font-semibold py-2 px-6 rounded shadow"
        >
          MAX BET
        </button>
      </div>

      {/* Stats */}
      <div className="bg-black bg-opacity-40 p-6 rounded-lg w-full max-w-xl text-white space-y-2 border-2 border-yellow-500">
        <div className="flex justify-between items-center">
          <span>Bet Amount:</span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="1"
              max={balance}
              value={bet}
              onChange={handleBetChange}
              className="w-24 px-2 py-1 rounded text-black text-right"
            />
          </div>
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
