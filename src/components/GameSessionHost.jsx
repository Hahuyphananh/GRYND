"use client";

// src/components/GameSessionHost.jsx
//
// Drop-in host for game pages. It renders its children unchanged and owns
// the two page-level side effects a live match needs:
//
//   1. "Recently played" (casino lobby strip) — records the play on the
//      real game-start edge (autoStart flips true), once per edge.
//   2. Active-player presence (lobby "N playing" badge) — beats while the
//      game is live and clears the moment it ends.
//
// Pass the game's REAL lifecycle signals, derived from the game's own state
// machine, never page load:
//
//   <GameSessionHost
//     autoStart={matchStarted}   // true when the actual game starts
//     autoStop={matchEnded}      // true when the game reaches its result
//     gameLabel="plinko-duel"    // recently-played key + presence game id
//     presenceEnabled={!isSpectator} // false when the viewer is NOT playing
//   >
//     {gameContent}
//   </GameSessionHost>

import React, { useEffect, useRef } from "react";
import { recordPlayedGame } from "../lib/recentlyPlayed";
import useActiveGamePresence from "../hooks/useActiveGamePresence";

export default function GameSessionHost({
  autoStart = false,
  autoStop = false,
  gameLabel = "game",
  // Active-player presence (lobby "N playing" badge). Default true because
  // autoStart already means "a real game session is live"; only a VIEW-ONLY
  // surface (a spectator on a shared link) has to opt out.
  presenceEnabled = true,
  children = null,
}) {
  // Record the play when the REAL game session starts (autoStart flips true),
  // so the casino lobby can show a "Recently played" strip. Fire once per
  // autoStart edge; best-effort, never blocks the game.
  const prevAutoStartRef = useRef(false);
  useEffect(() => {
    if (autoStart && !prevAutoStartRef.current) {
      recordPlayedGame(gameLabel);
    }
    prevAutoStartRef.current = autoStart;
  }, [autoStart, gameLabel]);

  // Active-player presence: beat while the game is live (autoStart) and stop
  // the moment it is over (autoStop) — `terminal` clears the row immediately
  // instead of letting it age out of the activity window.
  useActiveGamePresence(gameLabel, autoStart && !autoStop, {
    enabled: presenceEnabled,
    terminal: autoStop,
  });

  return children ?? null;
}
