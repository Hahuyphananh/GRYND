"use client";
import React, { useState, useEffect } from "react";
import { CHIP_VALUES } from "../lib/rouletteConfig";

export default function BetPanel({
  placeBet,
  hasBet,
  gameRunning,
  isCrashed,
  refreshTrigger = 0,
}) {
  const [amount, setAmount] = useState("");
  const [autoCashout, setAutoCashout] = useState(2.0);
  const [userTokens, setUserTokens] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

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

  const numericAmount = parseInt(amount) || 0;

  const handlePlaceBet = () => {
    if (!amount || numericAmount <= 0) return;
    if (numericAmount > userTokens) {
      setError("Insufficient balance");
      return;
    }
    setError(null);
    placeBet(numericAmount, parseFloat(autoCashout) || 2.0);
  };

  return (
    <div className="relative w-full">
      <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-[#00e5ff] to-transparent opacity-80"></div>

      <div
        className="bg-[#050d1f]/80 backdrop-blur-xl border border-[#00e5ff]/40 
                    shadow-[0_0_25px_rgba(0,229,255,0.25),inset_0_0_25px_rgba(0,229,255,0.08)]
                    p-4 rounded-2xl flex flex-col gap-4 w-full"
      >
        <h2
          className="text-2xl font-extrabold tracking-wider text-transparent bg-clip-text 
                     bg-gradient-to-r from-[#00e5ff] to-[#00ffa6]"
        >
          ⚡ PLACE BET
        </h2>

        <div
          className="text-lg font-semibold text-[#00e5ff] 
                      drop-shadow-[0_0_10px_rgba(0,229,255,0.8)]"
        >
          Balance:{" "}
          {loading
            ? "..."
            : userTokens.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}{" "}
          Tokens
        </div>

        {error && (
          <div className="text-red-400 text-sm border border-red-500/40 bg-red-900/20 p-2 rounded">
            {error}
          </div>
        )}

        {/* Quick chip values */}
        <div className="flex flex-wrap gap-1.5 justify-center">
          {CHIP_VALUES.map((val) => (
            <button
              key={val}
              onClick={() => setAmount(val.toString())}
              disabled={gameRunning || hasBet}
              className={`px-2 py-0.5 rounded-full text-xs font-bold border transition-all duration-150 ${
                numericAmount === val
                  ? "bg-[#FFFF33] text-black border-[#FFFF33] shadow-[0_0_10px_rgba(255,255,51,0.6)] scale-110"
                  : "bg-[#0a1a3a] text-[#FFFF33]/80 border-[#FFFF33]/30 hover:bg-[#FFFF33]/20 hover:border-[#FFFF33]/60"
              } ${gameRunning || hasBet ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              {val}
            </button>
          ))}
        </div>

        {/* Bet Amount */}
        <div className="flex flex-col gap-1 min-w-0">
          <label className="text-sm text-gray-300">Bet Amount</label>
          <div className="flex items-center gap-1 min-w-0">
            <input
              type="number"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onBlur={() => { if (!amount || parseInt(amount) < 1) setAmount(""); }}
              placeholder="Enter bet..."
              disabled={gameRunning || hasBet}
              className="flex-1 min-w-0 w-full bg-[#020617] border border-[#00e5ff]/30
                       focus:border-[#00e5ff] focus:shadow-[0_0_15px_rgba(0,229,255,0.6)]
                       rounded-xl px-2 py-2 text-white outline-none
                       transition-all duration-300 text-center"
            />
            <button
              onClick={() => setAmount(Math.max(1, Math.floor(userTokens / 2)).toString())}
              disabled={gameRunning || hasBet}
              aria-label="Bet half of balance"
              className="shrink-0 px-2.5 py-2 rounded-lg border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] text-xs font-bold hover:bg-[#FFFF33]/25 transition disabled:opacity-50 whitespace-nowrap"
            >
              ½
            </button>
            <button
              onClick={() => setAmount(Math.max(1, userTokens).toString())}
              disabled={gameRunning || hasBet}
              aria-label="Bet entire balance"
              className="shrink-0 px-2.5 py-2 rounded-lg border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] text-xs font-bold hover:bg-[#FFFF33]/25 transition disabled:opacity-50 whitespace-nowrap"
            >
              MAX
            </button>
            <button
              onClick={() => setAmount(Math.min((numericAmount || 1) * 2, userTokens).toString())}
              disabled={gameRunning || hasBet}
              aria-label="Double the bet"
              className="shrink-0 px-2.5 py-2 rounded-lg border border-[#FFFF33]/30 bg-[#FFFF33]/15 text-[#FFFF33] text-xs font-bold hover:bg-[#FFFF33]/25 transition disabled:opacity-50 whitespace-nowrap"
            >
              2×
            </button>
          </div>
        </div>

        {/* Auto Cashout */}
        <div className="flex flex-col gap-1">
          <label className="text-sm text-gray-300">Auto Cashout (x)</label>
          <input
            type="number"
            value={autoCashout}
            step="0.1"
            min="1.1"
            onChange={(e) => setAutoCashout(parseFloat(e.target.value) || 1.1)}
            placeholder="2.0x"
            disabled={gameRunning || hasBet}
            className="bg-[#020617] border border-[#00ffa6]/30 
                     focus:border-[#00ffa6] focus:shadow-[0_0_15px_rgba(0,255,166,0.6)]
                     rounded-xl px-3 py-3 text-white outline-none
                     transition-all duration-300"
          />
        </div>

        <button
          onClick={handlePlaceBet}
          disabled={gameRunning || hasBet || numericAmount > userTokens || numericAmount <= 0}
          className={`py-3 rounded-xl font-bold text-lg transition-all duration-300
          ${
            hasBet
              ? "bg-[#1a2333] text-gray-400 border border-gray-600"
              : numericAmount > userTokens
                ? "bg-[#2a0a0a] text-red-400 border border-red-500"
                : numericAmount <= 0
                  ? "bg-[#1a2333] text-gray-500 border border-gray-600 cursor-not-allowed"
                  : "bg-gradient-to-r from-[#00e5ff] to-[#00ffa6] text-[#001933] border border-[#00e5ff] shadow-[0_0_20px_rgba(0,229,255,0.6)] hover:shadow-[0_0_35px_rgba(0,255,166,1)] hover:scale-105"
          }
        `}
        >
          {hasBet
            ? "BET PLACED"
            : numericAmount > userTokens
              ? "INSUFFICIENT BALANCE"
              : numericAmount <= 0
                ? "ENTER BET AMOUNT"
                : "PLACE BET"}
        </button>
      </div>
    </div>
  );
}
