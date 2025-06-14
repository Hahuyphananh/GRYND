'use client';
import React, { useState, useEffect } from "react";

export default function BetPanel({
  placeBet,
  hasBet,
  gameRunning,
  isCrashed,
  refreshTrigger = 0, // 👈 to trigger re-fetch from parent
}) {
  const [amount, setAmount] = useState("");
  const [autoCashout, setAutoCashout] = useState(2.0);
  const [userTokens, setUserTokens] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // ✅ Fetch user tokens on load and whenever refreshTrigger changes
  useEffect(() => {
    async function fetchTokens() {
      setLoading(true);
      try {
        const response = await fetch("/api/get-user-tokens", { method: "POST" });
        const data = await response.json();
        if (data.success) {
          setUserTokens(parseFloat(data.data.balance));
        } else {
          throw new Error(data.error || "Unknown error");
        }
      } catch (err) {
        console.error("Failed to fetch tokens:", err);
        setError("Could not load token balance");
      } finally {
        setLoading(false);
      }
    }

    fetchTokens();
  }, [refreshTrigger]);

  const handlePlaceBet = () => {
    if (!amount || isNaN(amount)) return;
    placeBet(parseFloat(amount), parseFloat(autoCashout));
  };

  return (
    <div className="bg-gray-800 p-6 rounded-lg flex flex-col gap-4 w-full md:w-100%">
      <h2 className="text-2xl font-bold mb-2">Place Bet</h2>

      {/* ✅ Token balance display */}
      <div className="text-yellow-400 text-lg font-semibold">
        🪙 Balance: {loading ? "..." : !isNaN(userTokens) ? userTokens.toFixed(2) : "0.00"}
      </div>
      {error && <div className="text-red-500 text-sm">{error}</div>}

      <input
        type="number"
        value={amount}
        onChange={e => setAmount(e.target.value)}
        placeholder="Bet Amount ($)"
        className="bg-gray-700 p-3 rounded text-white"
        disabled={gameRunning || hasBet}
      />
      <input
        type="number"
        value={autoCashout}
        step="0.1"
        onChange={e => setAutoCashout(e.target.value)}
        placeholder="Auto Cashout (e.g. 2.0x)"
        className="bg-gray-700 p-3 rounded text-white"
        disabled={gameRunning || hasBet}
      />
      <button
        onClick={handlePlaceBet}
        disabled={gameRunning || hasBet}
        className="bg-yellow-500 hover:bg-yellow-600 py-3 rounded-lg font-bold"
      >
        {hasBet ? "Bet Placed" : "Place Bet"}
      </button>
    </div>
  );
}
