"use client";

// src/components/odds/AnimatedScore.tsx
//
// Counts a cumulative score up to the value the SERVER returned. The animated
// number is display only: nothing reads it, nothing compares it, and the round
// result never waits for it. Reduced motion (or a value that did not change)
// renders the final number immediately.

import { useEffect, useRef, useState } from "react";
import { animate } from "framer-motion";
import { SCORE_SECONDS } from "./oddsMotion";
import { useReducedMotionSafe } from "./useReducedMotionSafe";

export type AnimatedScoreProps = {
  value: number;
  className?: string;
};

export default function AnimatedScore({ value, className = "" }: AnimatedScoreProps) {
  const reduce = useReducedMotionSafe();
  const [display, setDisplay] = useState(value);
  const shownRef = useRef(value);

  useEffect(() => {
    const from = shownRef.current;
    if (from === value) return undefined;
    if (reduce) {
      shownRef.current = value;
      setDisplay(value);
      return undefined;
    }
    const controls = animate(from, value, {
      duration: SCORE_SECONDS,
      ease: "easeOut",
      onUpdate: (next) => {
        const rounded = Math.round(next);
        shownRef.current = rounded;
        setDisplay(rounded);
      },
      onComplete: () => {
        shownRef.current = value;
        setDisplay(value);
      },
    });
    return () => controls.stop();
  }, [value, reduce]);

  return <span className={className}>{display}</span>;
}
