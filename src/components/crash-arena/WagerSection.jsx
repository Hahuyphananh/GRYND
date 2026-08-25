"use client";
import React from "react";
import { CRASH_WAGERS, CRASH_MIN_WAGER, CRASH_MIN_BUYIN_MULTIPLIER } from "../../lib/games/crash/constants";

/**
 * WagerSection — Create Table card with custom wager input.
 *
 * Renders a wager input field with quick-pick presets, a dynamic
 * min-buy-in display, and a Create Table button.
 *
 * Props:
 *   wager        — current wager input value
 *   setWager     — (value) => void — update wager
 *   isSignedIn   — whether the user is authenticated
 *   creating     — whether a create request is in flight
 *   onCreate     — (wager) => void — create a brand-new table
 *   userBalance  — player's wallet balance (null = loading)
 */
export default function WagerSection({
  wager,
  setWager,
  isSignedIn = false,
  creating = false,
  onCreate,
  userBalance,
}) {
  const wagerNum = Number(wager) || 0;
  const minBuyIn = wagerNum * CRASH_MIN_BUYIN_MULTIPLIER;
  const isValid = wagerNum >= CRASH_MIN_WAGER && (userBalance == null || wagerNum <= userBalance);

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-amber-700/60 bg-black/40 transition-all duration-300 hover:border-amber-500/60 hover:shadow-[0_0_30px_rgba(251,191,36,0.2)]">
      {/* ═══ Table creation card ═══ */}
      <div className="relative p-5 flex flex-col gap-3">
        {/* Top accent line */}
        <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-amber-400 to-transparent opacity-70" />

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <span className="text-xs uppercase tracking-widest text-cyan-100/60">
              Create Table
            </span>
            <div className="text-sm font-bold text-white/90 mt-0.5">
              Set your round wager
            </div>
          </div>
          <span className="px-3 py-1 rounded-full text-xs font-bold border border-cyan-500/40 bg-cyan-500/15 text-cyan-300">
            Custom
          </span>
        </div>

        {/* Wager input */}
        <div>
          <label className="text-xs text-white/55 uppercase tracking-wider">Round Wager</label>
          <div className="flex items-center mt-1 bg-[#020617] border border-amber-600/50 rounded-xl overflow-hidden focus-within:border-amber-400 focus-within:shadow-[0_0_15px_rgba(251,191,36,0.35)] transition-all">
            <span className="pl-4 text-amber-300 font-bold text-lg">$</span>
            <input
              type="number"
              value={wager}
              onChange={(e) => {
                const val = e.target.value;
                if (val === "" || val === "0") {
                  setWager(val);
                } else {
                  setWager(Math.max(CRASH_MIN_WAGER, parseFloat(val) || CRASH_MIN_WAGER));
                }
              }}
              min={CRASH_MIN_WAGER}
              step="0.01"
              className="flex-1 bg-transparent px-2 py-3 text-white text-lg font-bold outline-none text-center"
              placeholder={`${CRASH_MIN_WAGER}`}
            />
          </div>
        </div>

        {/* Quick presets */}
        <div className="flex flex-wrap gap-2 justify-center">
          {CRASH_WAGERS.map((val) => (
            <button
              key={val}
              onClick={() => setWager(val)}
              className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all duration-150
                ${wagerNum === val
                  ? "bg-amber-400 text-black border-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.5)]"
                  : "bg-slate-900/80 text-amber-200/80 border-amber-600/30 hover:bg-amber-500/15 hover:border-amber-500/50"
                }`}
            >
              ${val.toLocaleString()}
            </button>
          ))}
        </div>

        {/* Dynamic info */}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="flex flex-col">
            <span className="text-cyan-100/50 text-xs">Min Buy-in</span>
            <span className="text-white/90 font-semibold">
              {wagerNum >= CRASH_MIN_WAGER ? `$${minBuyIn.toLocaleString()}` : "—"}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-cyan-100/50 text-xs">Capacity</span>
            <span className="text-white/90 font-semibold">6 players</span>
          </div>
        </div>

        {/* Create Table button */}
        <button
          onClick={() => onCreate?.(wagerNum)}
          disabled={creating || !isValid || !isSignedIn}
          className={`mt-1 w-full py-2.5 rounded-xl font-bold text-sm text-center transition-all duration-300
            bg-amber-500 text-black border-b-4 border-amber-700
            hover:brightness-110 hover:scale-[1.02] hover:shadow-[0_0_20px_rgba(251,191,36,0.4)]
            disabled:opacity-60 disabled:hover:scale-100`}
        >
          {creating ? "Creating…" : "＋ Create Table"}
        </button>

        {!isSignedIn && (
          <p className="text-[11px] text-amber-200/70 text-center">
            Sign in to create a table.
          </p>
        )}
        {isSignedIn && wagerNum > 0 && userBalance != null && wagerNum > userBalance && (
          <p className="text-[11px] text-red-400/80 text-center">
            Insufficient balance for a ${wagerNum} wager
          </p>
        )}
      </div>
    </div>
  );
}
