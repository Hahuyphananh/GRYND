"use client";
import React, { useEffect, useState } from "react";
import { useReducedMotion } from "framer-motion";

/**
 * PotDisplay — animated pot counter with glow effect.
 *
 * Props:
 *   pot      — current pot value
 *   pots     — optional pot-tier breakdown [{ level, amount }] from the
 *              rules engine (main pot + side pots) — shown as a compact
 *              "Main $X · Side $Y" line when there are multiple tiers
 *   currency — prefix (default "$")
 */
export default function PotDisplay({ pot = 0, pots = [], currency = "$" }) {
  const [displayed, setDisplayed] = useState(pot);
  const [isAnimating, setIsAnimating] = useState(false);
  // Reduced motion: the pot jumps straight to its new value instead of
  // counting up (and never takes the count-up scale). The count is a JS timer,
  // so the global CSS reduced-motion block can't collapse it — it is gated
  // here with the same hook the rest of the game uses.
  const shouldReduce = useReducedMotion();

  useEffect(() => {
    if (pot === displayed) return;
    if (shouldReduce) {
      setIsAnimating(false);
      setDisplayed(pot);
      return;
    }
    setIsAnimating(true);
    // Animate toward target
    const step = Math.max(1, Math.floor(Math.abs(pot - displayed) / 20));
    const timer = setInterval(() => {
      setDisplayed((prev) => {
        if (Math.abs(prev - pot) <= step) {
          clearInterval(timer);
          setIsAnimating(false);
          return pot;
        }
        return prev < pot ? prev + step : prev - step;
      });
    }, 30);
    return () => clearInterval(timer);
  }, [pot, shouldReduce]);

  // Tier labels: level 0 = carry-over, otherwise main pot (lowest level)
  // then side pots ascending.
  const tiers = Array.isArray(pots) ? pots.filter((t) => t && t.amount > 0) : [];
  const tierLine = tiers.length > 1
    ? tiers.map((t, i) => ({
        label: i === 0 ? "Main" : `Side ${i}`,
        amount: t.amount,
      }))
    : [];

  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-xs uppercase tracking-widest text-[#9dd8ff]/70">Pot</span>
      <div
        className={`text-3xl font-black text-[#FFD700] drop-shadow-[0_0_20px_rgba(255,215,0,0.5)] transition-all duration-200
          ${isAnimating ? "scale-110" : "scale-100"}`}
      >
        {currency}{displayed.toLocaleString()}
      </div>
      {tierLine.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-1.5 text-[10px] text-[#9dd8ff]/70">
          {tierLine.map((t) => (
            <span key={t.label} className="rounded-full border border-[#00e5ff]/20 bg-[#00e5ff]/10 px-2 py-0.5 font-bold">
              {t.label} {currency}{t.amount.toLocaleString()}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
