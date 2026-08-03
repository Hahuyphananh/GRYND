"use client";
import React from "react";

/**
 * CashoutButton — the "Cash Out" button with glow and hover effects.
 *
 * Props:
 *   onCashout  — callback when button is clicked
 *   disabled   — whether the button is disabled
 *   className  — forwarded to button
 *   label      — button text (default: "💰 Cash Out")
 */
export default function CashoutButton({
  onCashout,
  disabled = false,
  className = "",
  label = "💰 Cash Out",
}) {
  return (
    <button
      onClick={onCashout}
      disabled={disabled}
      className={`bg-gradient-to-r from-[#00ffa6] to-[#00e5ff]
text-[#001933]
border border-[#00ffa6]
shadow-[0_0_20px_rgba(0,255,166,0.6)]
hover:shadow-[0_0_35px_rgba(0,255,166,1)]
hover:scale-105
transition-all duration-300 px-4 py-3 rounded-lg font-bold text-lg w-full
shadow-[0_0_14px_rgba(0,229,255,0.4)]
${disabled ? "opacity-50 cursor-not-allowed" : ""}
${className}`}
    >
      {label}
    </button>
  );
}
