"use client";

import { motion } from 'framer-motion';

export default function ObstacleCar({ laneIndex, active, crashed, direction = 'left', speedMs = 2600 }) {
  if (!active && !crashed) return null;

  const baseClass = direction === 'left' ? 'lane-runner-car lane-runner-car-left' : 'lane-runner-car lane-runner-car-right';

  return (
    <div
      className="pointer-events-none absolute left-0 right-0"
      style={{ top: laneIndex * 58 + 12 }}
      aria-hidden="true"
    >
      {crashed ? (
        <motion.div
          className="text-2xl"
          initial={{ x: direction === 'left' ? 260 : -260, opacity: 0.5, scale: 0.8 }}
          animate={{ x: 0, opacity: 1, scale: 1.12 }}
          transition={{ duration: 0.28, ease: 'easeOut' }}
        >
          🚗
        </motion.div>
      ) : (
        <div className={baseClass} style={{ animationDuration: `${speedMs}ms` }}>
          <span className="text-xl md:text-2xl">🚙</span>
        </div>
      )}
    </div>
  );
}
