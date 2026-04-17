"use client";

import React from 'react';
import { motion } from 'framer-motion';
import LaneStrip from './LaneStrip';
import PlayerSprite from './PlayerSprite';
import ObstacleCar from './ObstacleCar';

const LANE_WIDTH = 84;
const TRACK_HEIGHT = 460;
const PLAYER_Y = 214;

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
  const visualLane = hasLost ? crashLane : currentLane - 1;
  const cameraShift = Math.max(0, currentLane - 4) * 28;
  const playerX = Math.max(4, (visualLane + 1) * LANE_WIDTH - 54 - cameraShift);

  return (
    <div className={`relative rounded-2xl border border-zinc-400/30 bg-zinc-800 p-4 shadow-2xl ${hasLost ? 'lane-runner-screen-shake' : ''}`}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-[0.2em] text-zinc-100">Mission Uncrossable Mode</h2>
        <span className="rounded bg-black/40 px-2 py-1 text-xs text-zinc-100">Current x{currentMultiplier.toFixed(2)}</span>
      </div>

      <div className="relative h-[460px] overflow-hidden rounded-xl border border-white/15 bg-zinc-700">
        <div className="lane-runner-road-parallax absolute inset-0 opacity-55" />

        <motion.div
          className="relative z-10 flex h-full items-stretch gap-0 py-2"
          animate={{ x: -cameraShift }}
          transition={{ type: 'spring', stiffness: 120, damping: 24 }}
        >
          {lanes.map((laneIndex) => {
            const isCurrent = laneIndex === currentLane;
            const isPassed = laneIndex < currentLane;
            const isCrash = crashLane === laneIndex;
            return (
              <div key={laneIndex} className="relative h-full">
                <LaneStrip
                  laneIndex={laneIndex}
                  multiplier={laneMultipliers[laneIndex]}
                  isCurrent={isCurrent}
                  isPassed={isPassed}
                  isCrash={isCrash}
                  running={running}
                  onAttempt={(event) => onAttemptLane(laneIndex, event)}
                />
                <ObstacleCar laneIndex={laneIndex} laneWidth={LANE_WIDTH} crashed={isCrash} playerY={PLAYER_Y} />
              </div>
            );
          })}
        </motion.div>

        <PlayerSprite
          x={playerX}
          y={PLAYER_Y}
          crashed={Boolean(hasLost)}
          cashedOut={Boolean(hasCashedOut)}
          running={Boolean(running)}
        />

        {running && !hasLost && !hasCashedOut && (
          <motion.button
            type="button"
            className="absolute z-40 rounded-md bg-emerald-400 px-4 py-2 text-sm font-black text-black shadow-[0_0_14px_rgba(74,222,128,0.85)]"
            style={{ left: Math.max(8, playerX - 4), top: 164 }}
            onClick={onCashout}
            animate={{ scale: [1, 1.06, 1] }}
            transition={{ duration: 0.75, repeat: Infinity }}
          >
            CASH OUT
          </motion.button>
        )}
      </div>
    </div>
  );
}
