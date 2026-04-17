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
      className={`lane-runner-lane group relative h-14 w-full overflow-hidden rounded-lg border transition-all duration-300 ${
        isCurrent
          ? 'border-cyan-300/90 shadow-[0_0_18px_rgba(34,211,238,0.5)]'
          : 'border-white/10'
      } ${isCrash ? 'bg-red-900/40' : isPassed ? 'bg-emerald-900/35' : 'bg-[#1c2b78]/80'} ${
        !isCurrent || !running ? 'cursor-default' : 'cursor-pointer hover:border-white/45 hover:brightness-110'
      }`}
      aria-label={`Lane ${laneIndex + 1}, multiplier ${multiplier.toFixed(2)}x`}
    >
      <div className="lane-runner-road-lines absolute inset-0 opacity-80" />
      <div className="absolute left-4 top-1/2 -translate-y-1/2 text-xs font-semibold text-white/70">
        Lane {laneIndex + 1}
      </div>
      <div
        className={`absolute right-4 top-1/2 -translate-y-1/2 rounded-full px-3 py-1 text-xs font-bold transition ${
          isCurrent
            ? 'bg-cyan-300 text-slate-900 shadow-[0_0_12px_rgba(34,211,238,0.9)]'
            : isPassed
            ? 'bg-black/25 text-white/40'
            : 'bg-black/30 text-white/90'
        }`}
      >
        x{multiplier.toFixed(2)}
      </div>
      {isCurrent && running && (
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-[laneSweep_1.8s_linear_infinite]" />
      )}
    </button>
  );
}
