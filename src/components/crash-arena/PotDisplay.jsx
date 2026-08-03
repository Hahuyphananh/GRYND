"use client";
import React, { useEffect, useState } from "react";

/**
 * PotDisplay — animated pot counter with glow effect.
 *
 * Props:
 *   pot      — current pot value
 *   currency — prefix (default "$")
 */
export default function PotDisplay({ pot = 0, currency = "$" }) {
  const [displayed, setDisplayed] = useState(pot);
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    if (pot !== displayed) {
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
    }
  }, [pot]);

  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-xs uppercase tracking-widest text-[#9dd8ff]/70">Pot</span>
      <div
        className={`text-3xl font-black text-[#FFD700] drop-shadow-[0_0_20px_rgba(255,215,0,0.5)] transition-all duration-200
          ${isAnimating ? "scale-110" : "scale-100"}`}
      >
        {currency}{displayed.toLocaleString()}
      </div>
    </div>
  );
}
