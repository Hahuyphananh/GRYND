"use client";
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
        const response = await fetch("/api/get-user-tokens", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
        });
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
    <div className="relative w-full">
      {/* Top neon line */}
      <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent opacity-80"></div>

      <div
        className="bg-[#050d1f]/80 backdrop-blur-xl border border-[#00e5ff]/40 
                    shadow-[0_0_25px_rgba(0,229,255,0.25),inset_0_0_25px_rgba(0,229,255,0.08)]
                    p-6 rounded-2xl flex flex-col gap-5 w-full"
      >
        {/* Title */}
        <h2
          className="text-2xl font-extrabold tracking-wider text-transparent bg-clip-text 
                     bg-gradient-to-r from-[#00e5ff] to-[#00ffa6]"
        >
          ⚡ PLACE BET
        </h2>

        {/* Balance */}
        <div
          className="text-lg font-semibold text-[#00e5ff] 
                      drop-shadow-[0_0_10px_rgba(0,229,255,0.8)]"
        >
          Balance:{" "}
          {loading
            ? "..."
            : !isNaN(userTokens)
              ? userTokens.toFixed(2)
              : "0.00"}{" "}
          Tokens
        </div>

        {error && (
          <div className="text-red-400 text-sm border border-red-500/40 bg-red-900/20 p-2 rounded">
            {error}
          </div>
        )}

        {/* Bet Amount */}
        <div className="flex flex-col gap-1">
          <label className="text-sm text-gray-300">Bet Amount ($)</label>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Enter bet..."
            disabled={gameRunning || hasBet}
            className="bg-[#020617] border border-[#00e5ff]/30 
                     focus:border-[#00e5ff] focus:shadow-[0_0_15px_rgba(0,229,255,0.6)]
                     rounded-xl px-3 py-3 text-white outline-none
                     transition-all duration-300"
          />
        </div>

        {/* Auto Cashout */}
        <div className="flex flex-col gap-1">
          <label className="text-sm text-gray-300">Auto Cashout (x)</label>
          <input
            type="number"
            value={autoCashout}
            step="0.1"
            onChange={(e) => setAutoCashout(e.target.value)}
            placeholder="2.0x"
            disabled={gameRunning || hasBet}
            className="bg-[#020617] border border-[#00ffa6]/30 
                     focus:border-[#00ffa6] focus:shadow-[0_0_15px_rgba(0,255,166,0.6)]
                     rounded-xl px-3 py-3 text-white outline-none
                     transition-all duration-300"
          />
        </div>

        {/* Button */}
        <button
          onClick={handlePlaceBet}
          disabled={gameRunning || hasBet || Number(amount) > userTokens}
          className={`py-3 rounded-xl font-bold text-lg transition-all duration-300
          ${
            hasBet
              ? "bg-[#1a2333] text-gray-400 border border-gray-600"
              : Number(amount) > userTokens
                ? "bg-[#2a0a0a] text-red-400 border border-red-500"
                : "bg-gradient-to-r from-[#00e5ff] to-[#00ffa6] text-[#001933] border border-[#00e5ff] shadow-[0_0_20px_rgba(0,229,255,0.6)] hover:shadow-[0_0_35px_rgba(0,255,166,1)] hover:scale-105"
          }
        `}
        >
          {hasBet
            ? "BET PLACED"
            : Number(amount) > userTokens
              ? "INSUFFICIENT BALANCE"
              : "PLACE BET"}
        </button>
      </div>
    </div>
  );
}
