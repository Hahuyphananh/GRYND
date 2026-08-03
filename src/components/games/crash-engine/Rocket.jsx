"use client";
import React from "react";
import { motion } from "framer-motion";

/**
 * Rocket — animated rocket emoji for cash-out celebrations.
 *
 * Props:
 *   animate   — whether to play the entrance animation (default: true)
 *   size      — text size class (default: "text-7xl")
 *   className — forwarded to wrapper
 */
export default function Rocket({ animate = true, size = "text-7xl", className = "" }) {
  return (
    <motion.div
      initial={animate ? { scale: 0, rotate: -30 } : false}
      animate={{ scale: 1, rotate: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 12, delay: 0.3 }}
      className={`mb-2 ${size} ${className}`}
    >
      🚀
    </motion.div>
  );
}
