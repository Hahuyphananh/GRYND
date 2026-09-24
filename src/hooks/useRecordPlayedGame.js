"use client";

// src/hooks/useRecordPlayedGame.js
//
// Record a real game session into the casino lobby's "Recently played"
// strip (and the server-side "Most Played" counter) exactly once per start
// edge. This is the behaviour <GameSessionHost autoStart> used to provide
// for every game page; game pages that do not mount that host call this
// directly with their own real game-start signal.

import { useEffect, useRef } from "react";
import { recordPlayedGame } from "../lib/recentlyPlayed";

/**
 * @param {string} gameLabel stable game key (e.g. "hex-duel")
 * @param {boolean} started true once the REAL game session starts (never
 *   page load); the play is recorded on the rising edge only, so a game
 *   that stays live does not re-record on every render.
 */
export function useRecordPlayedGame(gameLabel, started) {
  const prevRef = useRef(false);
  useEffect(() => {
    if (started && !prevRef.current) recordPlayedGame(gameLabel);
    prevRef.current = started;
  }, [started, gameLabel]);
}
