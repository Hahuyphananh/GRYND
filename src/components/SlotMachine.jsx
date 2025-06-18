"use client";
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

const SlotMachine = () => {
  const [reels, setReels] = useState(
    Array.from({ length: 5 }, () => Array(3).fill("💰"))
  );
  const [balance, setBalance] = useState(0);
  const [bet, setBet] = useState(100);
  const [lastResult, setLastResult] = useState("");
  const [totalWin, setTotalWin] = useState(0);
  const [totalLoss, setTotalLoss] = useState(0);
  const [autoSpinning, setAutoSpinning] = useState(false);
  const autoSpinRef = useRef(null);

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

    try {
      const res = await fetch("/api/slots/play", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bet }),
      });

      const json = await res.json();
      if (!json.success) throw new Error(json.error);

      const { reels: newReels, winAmount, newBalance } = json.data;
      setReels(newReels);
      playSound(winAmount >= bet * 5 ? 1200 : winAmount >= bet * 2 ? 1000 : 700);

      setLastResult(
        winAmount >= bet * 5
          ? "🎉 JACKPOT!"
          : winAmount >= bet * 2
          ? "✅ Match!"
          : "❌ No match."
      );

      setBalance(newBalance);
      setTotalWin(prev => prev + winAmount);
      if (winAmount === 0) setTotalLoss(prev => prev + bet);
    } catch (err) {
      console.error("Slot error:", err);
      setLastResult("❌ Error playing slot");
    }
  };

  const startAutoSpin = () => {
    if (autoSpinning) return;
    setAutoSpinning(true);
    autoSpinRef.current = setInterval(handleSpin, 1200);
  };

  const stopAutoSpin = () => {
    setAutoSpinning(false);
    clearInterval(autoSpinRef.current);
  };

  const setMaxBet = () => {
    setBet(Math.min(1000, balance)); // You can adjust the max bet limit (1000 here)
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-purple-900 to-indigo-900 p-4 text-white">
      <div className="flex border-8 border-yellow-400 rounded-xl bg-purple-700 p-4 mb-6">
        {reels.map((column, colIdx) => (
          <div
            key={colIdx}
            className="flex flex-col items-center mx-1 bg-purple-900 p-2 rounded-lg"
          >
            {column.map((fruit, rowIdx) => (
              <div
                key={`${fruit}-${Date.now()}-${rowIdx}`}
                className="w-16 h-16 text-4xl flex items-center justify-center my-1 bg-purple-800 rounded animate-spinReel"
                style={{ animationDelay: `${colIdx * 0.05}s` }}
              >
                {fruit}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-4 mb-6">
        <button
          onClick={handleSpin}
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
          onClick={setMaxBet}
          className="bg-blue-500 hover:bg-blue-600 text-white font-semibold py-2 px-6 rounded shadow"
        >
          MAX BET
        </button>
      </div>

      <div className="bg-black bg-opacity-30 p-6 rounded-lg w-full max-w-xl text-white space-y-2">
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
            <button 
              onClick={() => setBet(prev => Math.max(1, prev - 10))}
              className="bg-gray-600 hover:bg-gray-700 text-white font-bold py-1 px-3 rounded"
            >
              -
            </button>
            <button 
              onClick={() => setBet(prev => Math.min(balance, prev + 10))}
              className="bg-gray-600 hover:bg-gray-700 text-white font-bold py-1 px-3 rounded"
            >
              +
            </button>
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
    </div>
  );
};

export default SlotMachine;