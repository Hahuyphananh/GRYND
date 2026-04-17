"use client";

import React from 'react';

export default function LaneStrip({
  laneIndex,
  multiplier,
  isCurrent,
  isPassed,
  isCrash,
  running,
  onAttempt,
}) {
  return (
    <button
      type="button"
      onClick={onAttempt}
      disabled={!isCurrent || !running}
      className={`group relative h-full w-[74px] shrink-0 overflow-hidden rounded-xl border transition-all duration-300 ${
        isCurrent
          ? 'border-cyan-300/90 shadow-[0_0_18px_rgba(34,211,238,0.55)]'
          : 'border-white/15'
      } ${isCrash ? 'bg-red-900/45' : isPassed ? 'bg-slate-900/80 opacity-70' : 'bg-[#1b2a7a]/85'} ${
        isCurrent && running ? 'cursor-pointer hover:brightness-110' : 'cursor-default'
      }`}
      aria-label={`Lane ${laneIndex + 1}, multiplier ${multiplier.toFixed(2)}x`}
    >
      <div className="lane-runner-column-lines absolute inset-0" />

      <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-black/30 px-2 py-1 text-[11px] font-bold text-white/85">
        x{multiplier.toFixed(2)}
      </div>

      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 text-[10px] font-semibold uppercase tracking-wide text-white/60">
        L{laneIndex + 1}
      </div>

      {isCurrent && running && (
        <div className="absolute inset-x-1 top-0 h-12 rounded-b-xl bg-gradient-to-b from-white/20 to-transparent animate-[laneVerticalSweep_1.7s_linear_infinite]" />
      )}
    </button>
  );
}
