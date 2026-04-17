"use client";

import { motion } from 'framer-motion';

export default function PlayerSprite({ x, y, crashed, cashedOut, running }) {
  return (
    <motion.div
      className="pointer-events-none absolute z-30"
      animate={{
        left: `${x}%`,
        top: y,
        scale: crashed ? [1, 1.1, 0.96] : cashedOut ? [1, 1.15, 1] : 1,
        rotate: crashed ? [0, -10, 8, -6, 0] : 0,
        filter: crashed ? 'drop-shadow(0 0 18px rgba(239,68,68,0.8))' : 'drop-shadow(0 0 12px rgba(34,211,238,0.65))',
      }}
      transition={{
        left: { type: 'spring', stiffness: 135, damping: 20 },
        top: { type: 'spring', stiffness: 135, damping: 20 },
        scale: { duration: 0.35 },
      }}
    >
      <motion.div
        className="text-3xl md:text-4xl"
        animate={running && !crashed ? { y: [0, -5, 0] } : { y: 0 }}
        transition={{ repeat: Infinity, duration: 0.55, ease: 'easeInOut' }}
      >
        {crashed ? '💥🐔' : '🐔'}
      </motion.div>
    </motion.div>
  );
}
