"use client";

import { useEffect, useRef, useState } from "react";

/**
 * useTurnTimer
 *
 * A countdown timer that resets whenever `resetKey` changes, ticks down
 * only while `isActive` is true, and fires `onExpire` when it reaches 0.
 *
 * Returns the time remaining in seconds, a 0–1 fraction, and an `isUrgent`
 * flag for styling (< 30s = urgent, < 10s = critical).
 */
export function useTurnTimer({
  isActive,
  duration = 120,
  onExpire,
  resetKey,
}: {
  isActive: boolean;
  duration?: number;
  onExpire: () => void;
  resetKey: string | number;
}) {
  const [timeLeft, setTimeLeft] = useState(duration);
  const startedAtRef = useRef(Date.now());
  const expireCalledRef = useRef(false);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  // Reset whenever the key (e.g. turn indicator) changes
  useEffect(() => {
    setTimeLeft(duration);
    startedAtRef.current = Date.now();
    expireCalledRef.current = false;
  }, [resetKey, duration]);

  // Countdown tick
  useEffect(() => {
    if (!isActive) {
      // Pause — keep the current displayed value
      return;
    }

    expireCalledRef.current = false;

    const interval = setInterval(() => {
      const elapsed = (Date.now() - startedAtRef.current) / 1000;
      const remaining = Math.max(0, duration - elapsed);
      setTimeLeft(remaining);

      if (remaining <= 0 && !expireCalledRef.current) {
        expireCalledRef.current = true;
        clearInterval(interval);
        onExpireRef.current();
      }
    }, 100); // 100 ms for a smooth progress bar

    return () => clearInterval(interval);
  }, [isActive, resetKey, duration]);

  const fraction = duration > 0 ? timeLeft / duration : 0;
  const isUrgent = timeLeft <= 30;
  const isCritical = timeLeft <= 10;

  return {
    /** Seconds remaining (float, use Math.ceil for display) */
    timeLeft,
    /** 0 → 1 where 1 = full time remaining */
    fraction,
    /** ≤ 30 seconds left */
    isUrgent,
    /** ≤ 10 seconds left */
    isCritical,
  } as const;
}
