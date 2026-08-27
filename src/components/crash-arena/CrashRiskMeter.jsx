"use client";
import React from "react";

/**
 * Pure risk mapping: how dangerous the current multiplier FEELS.
 *
 * risk(multiplier) = 1 − e^(−(m−1)/1.9), clamped to [4%, 97%]:
 *   • strictly increasing — higher multiplier = genuinely more dangerous,
 *     because the server-authoritative crash point is somewhere above the
 *     current curve and each step makes the next instant riskier;
 *   • never 0% (something can always go wrong) and never 100% (the meter
 *     must never claim the crash is certain — it isn't, until it happens);
 *   • a PURE function of the public multiplier — it is not the source of
 *     randomness and reveals nothing about the hidden crash point (the
 *     crash is decided by the server's seed, not by this meter).
 *
 * Because every client renders the same shared curve, the risk value is
 * synchronized across the table by construction — no extra sync needed.
 */
export function crashRiskFromMultiplier(multiplier) {
  const m = Math.max(1, Number(multiplier) || 1);
  const risk = 1 - Math.exp(-(m - 1) / 1.9);
  return Math.min(0.97, Math.max(0.04, risk));
}

/** Tailwind gradient class for the meter fill at a given risk. */
function riskGradient(risk) {
  if (risk < 0.4) return "from-[#22c55e] via-[#84cc16] to-[#eab308]";
  if (risk < 0.7) return "from-[#eab308] via-[#f97316] to-[#ef4444]";
  return "from-[#f97316] via-[#ef4444] to-[#dc2626]";
}

/**
 * CrashRiskMeter — continuously updating "CRASH RISK" gauge.
 *
 * A purely visual read on the shared multiplier: the fill climbs (green →
 * amber → red) as the curve climbs, pulsing when danger is high. It is
 * intentionally NOT connected to the hidden crash point — it cannot predict
 * when the crash will happen, only that the hand is getting more dangerous.
 *
 * Props:
 *   multiplier — current curve multiplier (1.00x → …)
 *   className  — extra classes for the outer wrapper
 */
export default function CrashRiskMeter({ multiplier = 1, className = "" }) {
  const risk = crashRiskFromMultiplier(multiplier);
  const percent = Math.round(risk * 100);
  const highDanger = risk >= 0.7;

  return (
    <div
      className={`pointer-events-none select-none px-3 py-2 rounded-xl border border-red-500/25 bg-[#050d1f]/75 backdrop-blur-sm ${className}`}
    >
      <div className="flex items-center justify-between gap-3 mb-1">
        <span
          className={`text-[10px] font-black uppercase tracking-widest ${
            highDanger ? "text-red-400" : "text-[#9dd8ff]"
          }`}
        >
          Crash Risk
        </span>
        <span
          className={`text-sm font-black tabular-nums ${
            highDanger ? "text-red-400" : "text-[#d8fbff]"
          }`}
        >
          {percent}%
        </span>
      </div>
      <div className="h-2 w-36 rounded-full bg-[#020617] border border-white/10 overflow-hidden">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${riskGradient(risk)} transition-[width] duration-150 ease-linear ${
            highDanger ? "animate-pulse" : ""
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-1 text-[9px] text-[#9dd8ff]/50 leading-tight">
        Danger rises with the multiplier — the crash can strike at any moment.
      </div>
    </div>
  );
}
