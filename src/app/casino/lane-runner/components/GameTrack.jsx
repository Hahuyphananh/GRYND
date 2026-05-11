"use client";

import React from "react";
import { motion } from "framer-motion";

function tileClasses({
  clickable,
  selected,
  isCurrent,
  isSafeReveal,
  isBadReveal,
  isLosingPick,
}) {
  if (isBadReveal)
    return "bg-gradient-to-br from-rose-600 to-red-800 border-red-300/60 text-white";
  if (isSafeReveal)
    return "bg-gradient-to-br from-emerald-500 to-green-700 border-emerald-300/70 text-white";
  if (selected && isCurrent)
    return "bg-gradient-to-br from-cyan-400 to-blue-600 border-cyan-100/70 text-white";
  if (clickable)
    return "bg-gradient-to-br from-indigo-700 to-indigo-900 border-cyan-300/35 text-cyan-100 hover:brightness-125";
  return "bg-gradient-to-br from-slate-700 to-slate-900 border-white/10 text-white/70";
}

export default function GameTrack({
  towerRows,
  towerWidth,
  currentLane,
  currentMultiplier,
  running,
  hasLost,
  hasCashedOut,
  crashLane,
  laneMultipliers,
  selectedTileByLane,
  safeTilesByLane,
  onAttemptTile,
  onCashout,
}) {
  const rowsTopFirst = [...towerRows].reverse();
  const scrollRef = React.useRef(null);
  const laneRefs = React.useRef({});

  React.useEffect(() => {
    const el = laneRefs.current[currentLane];
    if (el) {
      el.scrollIntoView({
        behavior: "smooth",
        block: "nearest", // or try 'center' vs 'nearest'
      });
    }
  }, [currentLane]);

  return (
    <div
      className={`relative overflow-hidden rounded-3xl border border-cyan-300/20 bg-slate-950/85 p-5 shadow-[0_0_55px_rgba(0,215,255,0.22)] ${hasLost ? "lane-runner-screen-shake" : ""}`}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-black uppercase tracking-[0.24em] text-cyan-100">
          Tower Climb
        </h2>
        <span className="rounded-full border border-cyan-300/40 bg-cyan-300/15 px-3 py-1 text-xs font-bold text-cyan-100">
          Current x{currentMultiplier.toFixed(2)}
        </span>
      </div>

      <div className="relative rounded-2xl border border-white/10 bg-gradient-to-b from-slate-900 via-[#111735] to-[#060916] p-3">
        <div className="pointer-events-none absolute inset-0 opacity-50 [background-image:radial-gradient(rgba(56,189,248,0.14)_1px,transparent_1px)] [background-size:10px_10px]" />

        <div
          ref={scrollRef}
          className="relative z-10 space-y-1 max-h-[65vh] overflow-y-auto pr-1"
        >
          {rowsTopFirst.map((lane) => {
            const isCurrent = lane === currentLane;
            const isCompleted = lane < currentLane;
            const isFuture = lane > currentLane;
            const selectedTile = selectedTileByLane[lane];
            const safeTiles = safeTilesByLane[lane] || [];
            const isCrashRow = crashLane === lane;

            return (
              <motion.div
                key={lane}
                ref={(el) => (laneRefs.current[lane] = el)}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className={`relative rounded-xl border p-1.5 ${
                  isCurrent
                    ? "border-cyan-300/65 bg-cyan-400/10"
                    : isCompleted
                      ? "border-emerald-400/35 bg-emerald-500/10"
                      : "border-white/10 bg-black/20"
                }`}
              >
                <div className="mb-2 flex items-center justify-between text-[11px]">
                  <span className="font-semibold text-white/75">
                    Level {lane + 1}
                  </span>
                  <span className="rounded-full bg-black/35 px-2 py-1 font-bold text-cyan-100">
                    x{laneMultipliers[lane].toFixed(2)}
                  </span>
                </div>

                <div
                  className="grid gap-2"
                  style={{
                    gridTemplateColumns: `repeat(${towerWidth}, minmax(0, 1fr))`,
                  }}
                >
                  {Array.from({ length: towerWidth }, (_, tileIndex) => {
                    const clickable = running && isCurrent;
                    const isSelected = selectedTile === tileIndex;
                    const isSafeReveal =
                      (isCompleted || (isCrashRow && hasLost)) &&
                      safeTiles.includes(tileIndex);
                    const isBadReveal =
                      isCrashRow && hasLost && !safeTiles.includes(tileIndex);
                    const isLosingPick = isCrashRow && hasLost && isSelected;

                    return (
                      <motion.button
                        key={`${lane}-${tileIndex}`}
                        type="button"
                        whileHover={clickable ? { scale: 1.04 } : undefined}
                        whileTap={clickable ? { scale: 0.95 } : undefined}
                        onClick={() => onAttemptTile(lane, tileIndex)}
                        disabled={
                          !clickable || isFuture || hasLost || hasCashedOut
                        }
                        className={`h-7 md:h-8 rounded-md border text-xs font-bold shadow transition-all ${tileClasses(
                          {
                            clickable,
                            selected: isSelected,
                            isCurrent,
                            isSafeReveal,
                            isBadReveal,
                            isLosingPick,
                          },
                        )}`}
                      >
                        {isLosingPick
                          ? "☠"
                          : isSafeReveal
                            ? "✓"
                            : isSelected
                              ? "●"
                              : "?"}
                      </motion.button>
                    );
                  })}
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>

      {running && !hasLost && !hasCashedOut && (
        <motion.button
          type="button"
          className="mt-4 w-full rounded-xl bg-gradient-to-r from-emerald-400 to-cyan-400 py-3 text-sm font-black uppercase tracking-wide text-black shadow-[0_0_25px_rgba(45,212,191,0.55)]"
          onClick={onCashout}
          animate={{ scale: [1, 1.03, 1] }}
          transition={{ repeat: Infinity, duration: 1.2 }}
        >
          Cash Out
        </motion.button>
      )}
    </div>
  );
}
