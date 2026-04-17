"use client";

import { motion } from 'framer-motion';

export default function ObstacleCar({ laneIndex, laneWidth = 84, crashed, playerY = 220 }) {
  if (!crashed) return null;

  const left = laneIndex * laneWidth;

  return (
    <div className="pointer-events-none absolute inset-y-0 z-20" style={{ left, width: laneWidth }} aria-hidden="true">
      <motion.div
        className="absolute left-1/2 -translate-x-1/2 rounded-md border border-white/40 bg-gradient-to-b from-slate-300 to-slate-500 shadow-[0_4px_16px_rgba(0,0,0,0.45)]"
        style={{ top: playerY - 6, width: laneWidth - 8, height: 38 }}
        initial={{ y: -460, opacity: 0.9 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.35, ease: 'easeIn' }}
      >
        <div className="flex h-full items-center justify-between px-2 text-sm">
          <span>🚗</span>
          <span>💥</span>
          <span>🚗</span>
        </div>
      </motion.div>
    </div>
  );
}
