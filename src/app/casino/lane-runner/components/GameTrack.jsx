"use client";

import React from 'react';
import { motion } from 'framer-motion';
import LaneStrip from './LaneStrip';
import PlayerSprite from './PlayerSprite';
import ObstacleCar from './ObstacleCar';

const LANE_HEIGHT = 58;

export default function GameTrack({
  lanes,
  currentLane,
  currentMultiplier,
  running,
  hasLost,
  hasCashedOut,
  crashLane,
  laneMultipliers,
  onAttemptLane,
  onCashout,
}) {
  const cameraShift = Math.max(0, currentLane - 2) * 16;
  const playerY = Math.max(4, currentLane * LANE_HEIGHT + 8 - cameraShift);

  return (
    <div className={`relative rounded-2xl border border-cyan-300/25 bg-[#111d5e] p-4 shadow-2xl ${hasLost ? 'lane-runner-screen-shake' : ''}`}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-[0.2em] text-cyan-200">Mission Uncrossable Mode</h2>
        <span className="rounded bg-black/35 px-2 py-1 text-xs text-white/80">Current x{currentMultiplier.toFixed(2)}</span>
      </div>

      <div className="relative h-[700px] overflow-hidden rounded-xl border border-white/10 bg-[#142062]">
        <div className="lane-runner-road-parallax absolute inset-0 opacity-60" />

        <motion.div
          className="relative z-10 flex flex-col gap-1 px-2 py-2"
          animate={{ y: -cameraShift }}
          transition={{ type: 'spring', stiffness: 120, damping: 24 }}
        >
          {lanes.map((laneIndex) => {
            const isCurrent = laneIndex === currentLane;
            const isPassed = laneIndex < currentLane;
            const isCrash = crashLane === laneIndex;
            return (
              <div key={laneIndex} className="relative">
                <LaneStrip
                  laneIndex={laneIndex}
                  multiplier={laneMultipliers[laneIndex]}
                  isCurrent={isCurrent}
                  isPassed={isPassed}
                  isCrash={isCrash}
                  running={running}
                  onAttempt={(event) => onAttemptLane(laneIndex, event)}
                />
                <ObstacleCar
                  laneIndex={laneIndex}
                  active={running && isCurrent}
                  crashed={isCrash}
                  direction={laneIndex % 2 ? 'left' : 'right'}
                  speedMs={2400 + (laneIndex % 4) * 230}
                />
              </div>
            );
          })}
        </motion.div>

        <PlayerSprite
          x={11}
          y={playerY}
          crashed={Boolean(hasLost)}
          cashedOut={Boolean(hasCashedOut)}
          running={Boolean(running)}
        />

        {running && !hasLost && !hasCashedOut && (
          <motion.button
            type="button"
            className="absolute left-20 z-40 rounded-md bg-emerald-400 px-4 py-2 text-sm font-black text-black shadow-[0_0_14px_rgba(74,222,128,0.85)]"
            style={{ top: Math.max(6, playerY - 42) }}
            onClick={onCashout}
            animate={{ scale: [1, 1.05, 1] }}
            transition={{ duration: 0.75, repeat: Infinity }}
          >
            CASH OUT
          </motion.button>
        )}
      </div>
    </div>
  );
}
