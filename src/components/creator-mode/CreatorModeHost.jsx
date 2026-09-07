"use client";

// src/components/creator-mode/CreatorModeHost.jsx
//
// The single drop-in integration point for games. Mount it once in a
// game page (client component) and pass the game's REAL lifecycle
// signals — derived from the game's own state machine, never page load:
//
//   <CreatorModeHost
//     autoStart={matchStarted}   // true when the actual game starts
//     autoStop={matchEnded}      // true when the game reaches its
//                                //   completed/result state
//     autoStopDelayMs={1600}     // optional: keep recording this long
//                                //   after the game ends so the
//                                //   result/winner animation is captured
//     autoStopOnIdle             // optional: stop immediately when the
//                                //   game leaves its live state without a
//                                //   result (e.g. a mid-game "return to
//                                //   lobby" button clears `game`) — use
//                                //   when autoStart reflects the live game
//     gameLabel="plinko-duel"    // used in the downloaded filename
//     backToLobbyHref={"/casino/plinko"} // optional: adds a "Go back to
//                                //   lobby" button to the result panel
//   >
//     {/* only the actual game content — nav/footer/modals stay outside */}
//   </CreatorModeHost>
//
// Lifecycle contract (same API as useCreatorModeLifecycle):
//   • autoStart  → gameStarted(): 3→2→1 countdown, then in-page capture
//   • autoStop   → gameFinished(): keep recording briefly, then stop
//   • unmount    → gameQuit(): stop immediately (user left the game)
//
// It wires Creator Mode from the lobby (URL/storage), the viewport
// recorder, the unobtrusive status indicator + result panel, and the
// automatic start-on-game-start / stop-on-game-end / stop-on-quit
// behaviour. No per-game recording logic is needed — this is the shared
// foundation.
//
// Rendering modes:
//   • Creator mode off / user without access → renders children
//     unchanged, no overlay.
//   • Creator mode on → renders children + the floating recording
//     overlay.

import React, { useEffect, useRef } from "react";
import CreatorModeProvider from "../../lib/creator-mode/CreatorModeProvider";
import CreatorModeOverlay from "./CreatorModeOverlay";
import { recordPlayedGame } from "../../lib/recentlyPlayed";

export default function CreatorModeHost({
  autoStart = false,
  autoStop = false,
  autoStopDelayMs = undefined,
  autoStopOnIdle = false,
  gameLabel = "game",
  // Optional: when set, the finished-recording result panel shows a
  // "Go back to lobby" button navigating to this href (e.g. "/casino/tower-arena").
  backToLobbyHref = undefined,
  children = null,
}) {
  // UX plan P1-1: record the play when the REAL game session starts
  // (autoStart flips true — the same signal Creator Mode records on), so
  // the casino lobby can show a "Recently played" strip. Fire once per
  // autoStart edge; best-effort, never blocks the game.
  const prevAutoStartRef = useRef(false);
  useEffect(() => {
    if (autoStart && !prevAutoStartRef.current) {
      recordPlayedGame(gameLabel);
    }
    prevAutoStartRef.current = autoStart;
  }, [autoStart, gameLabel]);

  return (
    <CreatorModeProvider
      autoStart={autoStart}
      autoStop={autoStop}
      autoStopDelayMs={autoStopDelayMs}
      autoStopOnIdle={autoStopOnIdle}
      gameLabel={gameLabel}
    >
      {children}
      <CreatorModeOverlay backToLobbyHref={backToLobbyHref} />
    </CreatorModeProvider>
  );
}
