"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useChessClock
 *
 * Individual chess clocks for two players. Each player has their own
 * 10-minute countdown. A player's clock only ticks down during their turn.
 * When a player's clock reaches 0, they lose.
 *
 * Returns each player's remaining time (in ms), a function to pause/resume
 * the active clock, and whether each player has expired.
 */
export function useChessClock({
  isActive,
  player1Time: initialP1Time = 600_000, // 10 min in ms
  player2Time: initialP2Time = 600_000,
  onPlayer1Expire,
  onPlayer2Expire,
  resetKey,
}: {
  /** Whether the game is running and clocks should tick */
  isActive: boolean;
  player1Time?: number;
  player2Time?: number;
  onPlayer1Expire: () => void;
  onPlayer2Expire: () => void;
  resetKey: string | number;
}) {
  const [p1TimeLeft, setP1TimeLeft] = useState(initialP1Time);
  const [p2TimeLeft, setP2TimeLeft] = useState(initialP2Time);
  const [p1Expired, setP1Expired] = useState(false);
  const [p2Expired, setP2Expired] = useState(false);

  const p1StartedAtRef = useRef<number | null>(null);
  const p2StartedAtRef = useRef<number | null>(null);
  const p1RemainingAtTurnStartRef = useRef(initialP1Time);
  const p2RemainingAtTurnStartRef = useRef(initialP2Time);
  const p1ExpireCalledRef = useRef(false);
  const p2ExpireCalledRef = useRef(false);
  const onP1ExpireRef = useRef(onPlayer1Expire);
  const onP2ExpireRef = useRef(onPlayer2Expire);
  onP1ExpireRef.current = onPlayer1Expire;
  onP2ExpireRef.current = onPlayer2Expire;

  // Tracks whose clock is ticking — "player1" | "player2" | null (paused)
  const activePlayerRef = useRef<"player1" | "player2" | null>(null);

  // Reset everything when game resets
  useEffect(() => {
    setP1TimeLeft(initialP1Time);
    setP2TimeLeft(initialP2Time);
    setP1Expired(false);
    setP2Expired(false);
    p1StartedAtRef.current = null;
    p2StartedAtRef.current = null;
    p1RemainingAtTurnStartRef.current = initialP1Time;
    p2RemainingAtTurnStartRef.current = initialP2Time;
    p1ExpireCalledRef.current = false;
    p2ExpireCalledRef.current = false;
    activePlayerRef.current = null;
    p1LastDisplayedRef.current = initialP1Time;
    p2LastDisplayedRef.current = initialP2Time;
  }, [resetKey, initialP1Time, initialP2Time]);

  // Track last displayed remaining (in ms) to avoid unnecessary re-renders
  const p1LastDisplayedRef = useRef(initialP1Time);
  const p2LastDisplayedRef = useRef(initialP2Time);

  // Main tick logic — runs every 250ms; only sets state when visible time changes
  useEffect(() => {
    if (!isActive) {
      // Game paused or over — stop all clocks
      p1StartedAtRef.current = null;
      p2StartedAtRef.current = null;
      activePlayerRef.current = null;
      return;
    }

    const interval = setInterval(() => {
      // P1's clock is ticking
      if (activePlayerRef.current === "player1" && p1StartedAtRef.current !== null) {
        const elapsed = Date.now() - p1StartedAtRef.current;
        const remaining = Math.max(0, p1RemainingAtTurnStartRef.current - elapsed);
        // Only re-render when the display changes by >=1 second to avoid unnecessary renders
        if (Math.abs(p1LastDisplayedRef.current - remaining) >= 1000) {
          p1LastDisplayedRef.current = remaining;
          setP1TimeLeft(remaining);
        }

        if (remaining <= 0 && !p1ExpireCalledRef.current) {
          p1ExpireCalledRef.current = true;
          setP1Expired(true);
          p1LastDisplayedRef.current = 0;
          setP1TimeLeft(0);
          activePlayerRef.current = null;
          clearInterval(interval);
          onP1ExpireRef.current();
        }
      }

      // P2's clock is ticking
      if (activePlayerRef.current === "player2" && p2StartedAtRef.current !== null) {
        const elapsed = Date.now() - p2StartedAtRef.current;
        const remaining = Math.max(0, p2RemainingAtTurnStartRef.current - elapsed);
        // Only re-render when the display changes by >=1 second to avoid unnecessary renders
        if (Math.abs(p2LastDisplayedRef.current - remaining) >= 1000) {
          p2LastDisplayedRef.current = remaining;
          setP2TimeLeft(remaining);
        }

        if (remaining <= 0 && !p2ExpireCalledRef.current) {
          p2ExpireCalledRef.current = true;
          setP2Expired(true);
          p2LastDisplayedRef.current = 0;
          setP2TimeLeft(0);
          activePlayerRef.current = null;
          clearInterval(interval);
          onP2ExpireRef.current();
        }
      }
    }, 250);

    return () => clearInterval(interval);
  }, [isActive, initialP1Time, initialP2Time]);

  /**
   * Start/switch the active clock. Call this when the active turn changes.
   * Passing null pauses all clocks (e.g. game over).
   */
  const setActivePlayer = useCallback((player: "player1" | "player2" | null) => {
    // Pause previous clock and record remaining time
    if (activePlayerRef.current === "player1" && p1StartedAtRef.current !== null) {
      const elapsed = Date.now() - p1StartedAtRef.current;
      const remaining = Math.max(0, p1RemainingAtTurnStartRef.current - elapsed);
      setP1TimeLeft(remaining);
      p1RemainingAtTurnStartRef.current = remaining;
      p1StartedAtRef.current = null;
    }
    if (activePlayerRef.current === "player2" && p2StartedAtRef.current !== null) {
      const elapsed = Date.now() - p2StartedAtRef.current;
      const remaining = Math.max(0, p2RemainingAtTurnStartRef.current - elapsed);
      setP2TimeLeft(remaining);
      p2RemainingAtTurnStartRef.current = remaining;
      p2StartedAtRef.current = null;
    }

    // Start new clock with current remaining time
    activePlayerRef.current = player;
    if (player === "player1") {
      // Use current state value for accuracy
      setP1TimeLeft((prev) => {
        p1RemainingAtTurnStartRef.current = prev;
        return prev;
      });
      p1StartedAtRef.current = Date.now();
    } else if (player === "player2") {
      setP2TimeLeft((prev) => {
        p2RemainingAtTurnStartRef.current = prev;
        return prev;
      });
      p2StartedAtRef.current = Date.now();
    }
  }, []);

  return {
    p1TimeLeft,
    p2TimeLeft,
    p1Expired,
    p2Expired,
    setActivePlayer,
  } as const;
}
