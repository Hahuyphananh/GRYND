"use client";
import React, { useState } from "react";
import { motion } from "framer-motion";
import { CRASH_MAX_BUYIN } from "../../lib/games/crash/constants";

/**
 * BuyInModal — modal to select buy-in amount before joining a table.
 *
 * Props:
 *   table      — { wager, minBuyIn, maxBuyIn? }
 *   onBuyIn    — (amount: number) => void
 *   onClose    — () => void
 *   maxBalance — player's total balance (optional cap)
 *
 * The buy-in is always capped at CRASH_MAX_BUYIN (10,000,000 tokens) so a
 * player can never put their entire balance in on a single buy-in.
 */
export default function BuyInModal({ table, onBuyIn, onClose, maxBalance }) {
  const { wager, minBuyIn } = table;
  // Effective upper bound: the table max (if any) × the global hard cap,
  // further limited by the player's own balance (if provided).
  const hardCap = CRASH_MAX_BUYIN;
  const tableMax = table.maxBuyIn ? Math.min(table.maxBuyIn, hardCap) : hardCap;
  const effectiveMax = Math.min(tableMax, maxBalance ?? tableMax);
  const [amount, setAmount] = useState(() => Math.min(minBuyIn, effectiveMax));

  const presets = [
    minBuyIn,
    minBuyIn * 2,
    minBuyIn * 5,
    Math.min(effectiveMax, hardCap),
  ].filter((v) => v >= minBuyIn && v <= effectiveMax);

  const updateAmount = (raw) => {
    let val = parseFloat(raw);
    if (!Number.isFinite(val) || val < minBuyIn) {
      setAmount(minBuyIn);
      return;
    }
    setAmount(Math.min(Math.floor(val), effectiveMax, hardCap));
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.9, opacity: 0, y: 20 }}
        transition={{ type: "spring", stiffness: 300, damping: 25 }}
        className="relative w-full max-w-sm overflow-hidden rounded-3xl border-2 border-amber-700/60 bg-gradient-to-b from-[#12042a] to-[#0a0118] p-6 shadow-[0_0_60px_rgba(251,191,36,0.2)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top glow line */}
        <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-amber-400 to-transparent" />

        <h2 className="text-2xl font-black text-amber-300 text-center mb-1">Buy In</h2>
        <p className="text-sm text-white/60 text-center mb-5">
          ${wager} table • Min buy-in: ${minBuyIn}
        </p>

        {/* Amount input */}
        <div className="mb-4">
          <label className="text-xs text-white/55 uppercase tracking-wider">Buy-in Amount</label>
          <div className="flex items-center mt-1 bg-[#020617] border border-amber-600/50 rounded-xl overflow-hidden focus-within:border-amber-400 focus-within:shadow-[0_0_15px_rgba(251,191,36,0.35)] transition-all">
            <span className="pl-4 text-amber-300 font-bold text-lg">$</span>
            <input
              type="number"
              value={amount}
              onChange={(e) => updateAmount(e.target.value)}
              min={minBuyIn}
              max={effectiveMax}
              step="1"
              className="flex-1 bg-transparent px-2 py-3 text-white text-lg font-bold outline-none text-center"
            />
          </div>
        </div>

        {/* Quick presets */}
        <div className="flex flex-wrap gap-2 justify-center mb-5">
          {presets.map((val) => (
            <button
              key={val}
              onClick={() => setAmount(val)}
              className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all duration-150
                ${amount === val
                  ? "bg-amber-400 text-black border-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.5)]"
                  : "bg-slate-900/80 text-amber-200/80 border-amber-600/30 hover:bg-amber-500/15 hover:border-amber-500/50"
                }`}
            >
              ${val.toLocaleString()}
            </button>
          ))}
        </div>

        {/* Buttons */}
        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-3 rounded-xl font-bold text-sm border border-gray-500/30 text-gray-400 hover:bg-gray-500/10 transition-all"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              if (amount >= minBuyIn && amount <= hardCap && amount <= (maxBalance ?? hardCap)) {
                onBuyIn(amount);
              }
            }}
            disabled={amount < minBuyIn || amount > hardCap || (maxBalance != null && amount > maxBalance)}
            className="flex-1 py-3 rounded-xl font-bold text-sm bg-amber-500 text-black border-b-4 border-amber-700 shadow-[0_0_20px_rgba(251,191,36,0.5)] hover:shadow-[0_0_35px_rgba(251,191,36,0.7)] hover:scale-105 transition-all duration-300 disabled:opacity-50 disabled:hover:scale-100"
          >
            Buy In • ${amount.toLocaleString()}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
