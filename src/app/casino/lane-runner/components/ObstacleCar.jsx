"use client";

import { motion } from 'framer-motion';

export default function ObstacleCar({ laneIndex, laneWidth = 74, active, crashed, direction = 'down', speedMs = 2600, playerY = 220 }) {
  if (!active && !crashed) return null;

  const left = laneIndex * laneWidth + 18;
  const moveClass = direction === 'down' ? 'lane-runner-car-down' : 'lane-runner-car-up';

  return (
    <div className="pointer-events-none absolute top-0 bottom-0 z-20" style={{ left }} aria-hidden="true">
      {crashed ? (
        <motion.div
          className="absolute text-2xl"
          style={{ top: playerY }}
          initial={{ x: -30, opacity: 0.5, scale: 0.85 }}
          animate={{ x: 0, opacity: 1, scale: 1.1 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
        >
          🚗
        </motion.div>
      ) : (
        <div className={`absolute left-0 text-2xl ${moveClass}`} style={{ animationDuration: `${speedMs}ms` }}>
          🚙
        </div>
      )}
    </div>
  );
}
