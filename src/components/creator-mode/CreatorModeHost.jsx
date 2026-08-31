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
//     gameLabel="plinko-duel"    // used in the downloaded filename
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

import React from "react";
import CreatorModeProvider from "../../lib/creator-mode/CreatorModeProvider";
import CreatorModeOverlay from "./CreatorModeOverlay";

export default function CreatorModeHost({
  autoStart = false,
  autoStop = false,
  autoStopDelayMs = undefined,
  gameLabel = "game",
  children = null,
}) {
  return (
    <CreatorModeProvider
      autoStart={autoStart}
      autoStop={autoStop}
      autoStopDelayMs={autoStopDelayMs}
      gameLabel={gameLabel}
    >
      {children}
      <CreatorModeOverlay />
    </CreatorModeProvider>
  );
}
