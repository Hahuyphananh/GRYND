"use client";

// src/components/creator-mode/CreatorModeOverlay.jsx
//
// Recording UX for Creator Mode — designed to NEVER obstruct gameplay:
//
//   • The in-game status + controls (armed / REC / Stop & save /
//     Download) render in a PORTAL fixed to the bottom of the viewport
//     (CreatorModeExteriorBar) — above the game's own UI, never inside
//     the recording frame, never recorded. Portaling guarantees they are
//     always visible and always clickable: they can't fall below the
//     fold of a page layout, be covered by page chrome / fixed bottom
//     bars, or lose clicks.
//   • Countdown        — the 3 → 2 → 1 ring (pure UI, pointer-events:
//     none; the game stays fully playable).
//   • After recording stops — the finished MP4/WebM is auto-downloaded
//     when the game ended normally (or the user pressed "Stop & save"),
//     so a clip can never be lost to navigation or a covering result
//     overlay (the auto-save is owned by CreatorModeExteriorBar). A clean
//     result panel (modal) then appears with the video preview
//     (play/pause), selected dimensions, duration, format, and Download /
//     Discard / Record-another actions. The recording stays local to the
//     browser — never uploaded or stored.
//
// Everything here is portaled to <body> (so it is never trapped inside
// the recording viewport's CSS transform or captured on video).
//
// Renders nothing when creator mode is off, so normal users never see it.

import React, { useState } from "react";
import { createPortal } from "react-dom";
import { useCreatorMode } from "../../lib/creator-mode/CreatorModeProvider";
import CreatorModeResultPanel from "./CreatorModeResultPanel";
import CreatorModeExteriorBar from "./CreatorModeExteriorBar";

export default function CreatorModeOverlay() {
  const {
    isCreatorMode,
    state,
    lastResult,
    supported,
    countdown,
    dimensions,
    gameEnded,
    discard,
    download,
    startCreatorRecording,
  } = useCreatorMode();

  if (!isCreatorMode) return null;

  const showResultPanel = state === "stopped" && lastResult !== null;

  // Record another game: discard the finished recording, then start
  // capturing again immediately when the game is still live, or simply
  // re-arm for the next match when it has ended.
  const recordAnotherGame = () => {
    discard();
    if (!gameEnded && supported && countdown === null) {
      startCreatorRecording();
    }
  };

  const ui = (
    <>
      {/* 3 → 2 → 1 countdown — centered, non-interactive. */}
      {countdown !== null && (
        <div className="pointer-events-none fixed inset-0 z-[80] flex items-center justify-center">
          <div className="flex h-40 w-40 items-center justify-center rounded-full border-4 border-[#00e5ff] bg-[#040d24]/85 shadow-[0_0_60px_rgba(0,229,255,0.5)]">
            <span className="text-7xl font-black text-[#f5ff3b] tabular-nums">
              {countdown}
            </span>
          </div>
        </div>
      )}

      {/* Creator controls — fixed at the bottom of the VIEWPORT (not the
          page), on the very top layer (z-[9998]) so NO page chrome,
          overlay, or fixed bar can sit above them and swallow clicks.
          Never inside the frame, never captured. The frame's scale
          reserves this bottom strip so the controls don't cover the
          game. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-3 z-[9998] flex justify-center px-3">
        <CreatorModeExteriorBar />
      </div>

      {/* Clean result panel — only after recording has stopped. */}
      {showResultPanel && (
        <CreatorModeResultPanel
          result={lastResult}
          selectedDimensions={dimensions}
          gameEnded={gameEnded}
          onDownload={() => download()}
          onDiscard={() => discard()}
          onRecordAnother={recordAnotherGame}
        />
      )}
    </>
  );

  return typeof document !== "undefined"
    ? createPortal(ui, document.body)
    : null;
}
