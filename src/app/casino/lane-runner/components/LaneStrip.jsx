"use client";

import React from 'react';

const VISUAL_SEWERS = 8;

export default function LaneStrip({ laneIndex, multiplier, isCurrent, isPassed, isCrash, running, onAttempt }) {
  return (
    <button
      type="button"
      onClick={onAttempt}
      disabled={!isCurrent || !running}
      className={`group relative h-full w-[84px] shrink-0 overflow-hidden border-y border-r border-white/20 transition-all duration-300 first:rounded-l-xl first:border-l first:border-l-white/20 last:rounded-r-xl ${
        isCrash ? 'bg-zinc-700' : isPassed ? 'bg-zinc-800/95' : 'bg-zinc-700/95'
      } ${isCurrent ? 'shadow-[inset_0_0_0_1px_rgba(34,211,238,0.75)]' : ''} ${
        isCurrent && running ? 'cursor-pointer hover:brightness-110' : 'cursor-default'
      }`}
      aria-label={`Lane ${laneIndex + 1}, multiplier ${multiplier.toFixed(2)}x`}
    >
      <div className="lane-runner-asphalt absolute inset-0" />

      <div className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full bg-black/45 px-2 py-1 text-[11px] font-black text-white">
        x{multiplier.toFixed(2)}
      </div>

      <div className="absolute inset-y-12 left-1/2 z-10 flex -translate-x-1/2 flex-col justify-between py-2">
        {Array.from({ length: VISUAL_SEWERS }).map((_, idx) => (
          <span key={`${laneIndex}-${idx}`} className="lane-runner-sewer" />
        ))}
      </div>

      {isCurrent && running && (
        <div className="absolute inset-x-1 top-0 h-10 rounded-b bg-gradient-to-b from-cyan-200/20 to-transparent animate-[laneVerticalSweep_1.8s_linear_infinite]" />
      )}
    </button>
  );
}
