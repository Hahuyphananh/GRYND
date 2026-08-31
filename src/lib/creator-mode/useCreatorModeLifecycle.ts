// src/lib/creator-mode/useCreatorModeLifecycle.ts
//
// Shared Creator Mode lifecycle hook — the canonical API every game
// integrates against (see CreatorModeLifecycle in ./types). It reads the
// provider context and returns the lifecycle contract:
//
//   creatorModeEnabled     — mode flag passed from the lobby
//   recordingDimensions    — selected output size (9:16 / 16:9 / 1:1 / custom)
//   gameStarted()          — call when the REAL game starts (never page load);
//                            runs the 3→2→1 countdown, then records
//   gameFinished()         — call when the game reaches its normal completed /
//                            result state; recording keeps running briefly
//                            (autoStopDelayMs) to capture the result/winner
//                            animation, then stops
//   gameQuit()             — call when the user quits; recording stops NOW
//   startCreatorRecording()/stopCreatorRecording() — explicit manual control
//
// The provider (mounted by <CreatorModeHost />) also drives the same
// functions automatically from its autoStart / autoStop props, so most
// games never need this hook at all. Use it only when a game needs to
// drive the lifecycle imperatively (e.g. a custom quit button that does
// not unmount the page).
//
// The recorder itself is never duplicated per game — it lives in the
// provider, and this hook is a thin, documented view over it.

"use client";

import { useCreatorMode } from "./CreatorModeProvider";
import type { CreatorModeLifecycle, RecordingState } from "./types";

export function useCreatorModeLifecycle(): CreatorModeLifecycle {
  // The provider is plain JSX, so its context value is untyped — cast the
  // recorder state (which the provider guarantees to be a RecordingState)
  // to satisfy the typed lifecycle contract.
  const ctx = useCreatorMode();

  return {
    creatorModeEnabled: ctx.creatorModeEnabled,
    recordingDimensions: ctx.recordingDimensions,
    gameStarted: ctx.gameStarted,
    gameFinished: ctx.gameFinished,
    gameQuit: ctx.gameQuit,
    startCreatorRecording: ctx.startCreatorRecording,
    stopCreatorRecording: ctx.stopCreatorRecording,
    state: ctx.state as RecordingState,
    lastResult: ctx.lastResult,
    error: ctx.error,
    download: ctx.download,
  };
}
