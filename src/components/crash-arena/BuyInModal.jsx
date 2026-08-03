"use client";
import React, { useState } from "react";
import { motion } from "framer-motion";

/**
 * BuyInModal — modal to select buy-in amount before joining a table.
 *
 * Props:
 *   table      — { wager, minBuyIn, maxBuyIn? }
 *   onBuyIn    — (amount: number) => void
 *   onClose    — () => void
 *   maxBalance — player's total balance (optional cap)
 */
export default function BuyInModal({ table, onBuyIn, onClose, maxBalance }) {
  const { wager, minBuyIn } = table;
  const maxBuyIn = table.maxBuyIn || minBuyIn * 10;
  const [amount, setAmount] = useState(minBuyIn);

  const presets = [minBuyIn, minBuyIn * 2, minBuyIn * 5, maxBuyIn].filter(
    (v) => v <= (maxBalance ?? Infinity),
  );

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
        className="relative w-full max-w-sm overflow-hidden rounded-3xl border-2 border-[#FFD700]/40 bg-gradient-to-b from-[#0a1a2e] to-[#040d24] p-6 shadow-[0_0_60px_rgba(255,215,0,0.2)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top glow line */}
        <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-[#FFD700] to-transparent" />

        <h2 className="text-2xl font-black text-[#FFD700] text-center mb-1">Buy In</h2>
        <p className="text-sm text-[#9dd8ff] text-center mb-5">
          ${wager} table • Min buy-in: ${minBuyIn}
        </p>

        {/* Amount input */}
        <div className="mb-4">
          <label className="text-xs text-[#9dd8ff]/70 uppercase tracking-wider">Buy-in Amount</label>
          <div className="flex items-center mt-1 bg-[#020617] border border-[#00e5ff]/30 rounded-xl overflow-hidden focus-within:border-[#00e5ff] focus-within:shadow-[0_0_15px_rgba(0,229,255,0.4)] transition-all">
            <span className="pl-4 text-[#FFD700] font-bold text-lg">$</span>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(Math.max(minBuyIn, parseInt(e.target.value) || minBuyIn))}
              min={minBuyIn}
              max={maxBuyIn}
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
                  ? "bg-[#FFD700] text-black border-[#FFD700] shadow-[0_0_10px_rgba(255,215,0,0.5)]"
                  : "bg-[#08142f] text-[#FFD700]/80 border-[#FFD700]/25 hover:bg-[#FFD700]/15 hover:border-[#FFD700]/50"
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
            onClick={() => onBuyIn(amount)}
            className="flex-1 py-3 rounded-xl font-bold text-sm bg-gradient-to-r from-[#FFD700] to-[#FFA500] text-black border border-[#FFD700] shadow-[0_0_20px_rgba(255,215,0,0.5)] hover:shadow-[0_0_35px_rgba(255,215,0,0.8)] hover:scale-105 transition-all duration-300"
          >
            Buy In • ${amount.toLocaleString()}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
