"use client";
import React from "react";
import { IconCash } from "@tabler/icons-react";

/**
 * CashoutButton — the "Cash Out" button with glow and hover effects.
 *
 * Props:
 *   onCashout  — callback when button is clicked
 *   disabled   — whether the button is disabled
 *   className  — forwarded to button
 *   label      — button text (default: "Cash Out")
 */
export default function CashoutButton({
  onCashout,
  disabled = false,
  className = "",
  label = "Cash Out",
}) {
  return (
    <button
      onClick={onCashout}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-1.5
w-full sm:w-auto
px-5 py-3 sm:py-2.5
rounded-xl font-black text-base sm:text-sm
bg-gradient-to-r from-[#00ffa6] to-[#00e5ff]
text-[#001933]
border border-[#00ffa6]
shadow-[0_0_20px_rgba(0,255,166,0.6)]
hover:shadow-[0_0_35px_rgba(0,255,166,1)]
hover:scale-105
transition-all duration-300
${disabled ? "opacity-50 cursor-not-allowed" : ""}
${className}`}
    >
      <IconCash size={16} />
      {label}
    </button>
  );
}
