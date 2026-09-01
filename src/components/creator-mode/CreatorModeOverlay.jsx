"use client";

// src/components/creator-mode/CreatorModeOverlay.jsx
//
// Recording UX for Creator Mode — designed to NEVER obstruct gameplay:
//
//   • Before recording — nothing over the game except a tiny
//     non-interactive "armed" pill. Creator Mode configuration (output
//     dimensions, enable/disable) lives in the LOBBY, not here.
//   • Countdown        — the 3 → 2 → 1 ring (pure UI, pointer-events:
//     none; the game stays fully playable).
//   • During recording — a tiny non-interactive REC pill. No buttons,
//     no panels, no input capture — nothing covers or blocks the game.
//   • After recording stops — a clean result panel (modal) with the
//     video preview (play/pause), selected dimensions, duration, format,
//     and Download / Discard / Record-another actions. The recording
//     stays local to the browser — never uploaded or stored.
//
// All elements are portaled to <body> (so they're never trapped inside
// the recording viewport's CSS transform) and the status pills use
// pointer-events: none, so they can never capture pointer input.
//
// Renders nothing when creator mode is off, so normal users never see it.

import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useCreatorMode } from "../../lib/creator-mode/CreatorModeProvider";
import CreatorModeResultPanel from "./CreatorModeResultPanel";

// Tiny status pill content per recorder state. `stopped` is handled by
// the result panel instead. All pills are non-interactive.
const STATE_PILL = {
  idle: { dot: "bg-[#6aa4d8]", label: "Creator Mode armed" },
  requesting: { dot: "bg-amber-400 animate-pulse", label: "Preparing…" },
  recording: { dot: "bg-red-500 animate-pulse", label: "REC" },
  error: { dot: "bg-red-400", label: "Recording unavailable" },
};

export default function CreatorModeOverlay() {
  const {
    isCreatorMode,
    state,
    error,
    lastResult,
    supported,
    countdown,
    dimensions,
    gameEnded,
    discard,
    download,
    startCreatorRecording,
    stopCreatorRecording,
  } = useCreatorMode();

  // "Stop & save": stop the capture, then download the finished MP4/WebM
  // as soon as the recorder finalises it. The result panel still appears
  // afterwards (preview + re-download + discard).
  const [pendingDownload, setPendingDownload] = useState(false);

  useEffect(() => {
    if (pendingDownload && state === "stopped" && lastResult) {
      setPendingDownload(false);
      download();
    }
  }, [pendingDownload, state, lastResult, download]);

  const stopAndSave = () => {
    setPendingDownload(true);
    stopCreatorRecording();
  };

  if (!isCreatorMode) return null;

  const pill = STATE_PILL[state] || null;
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

      {/* Stop & save — the one interactive control during recording. */}
      {state === "recording" && (
        <button
          onClick={stopAndSave}
          className="fixed bottom-14 right-4 z-[60] flex items-center gap-1.5 rounded-full border border-red-400/60 bg-red-600/90 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-white shadow-[0_0_16px_rgba(239,68,68,0.5)] transition hover:bg-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" />
          ⏹ Stop & save
        </button>
      )}

      {/* Tiny non-interactive status pill (armed / preparing / REC / error). */}
      {pill && !showResultPanel && (
        <div
          className="pointer-events-none fixed bottom-4 right-4 z-[60] flex items-center gap-1.5 rounded-full border border-[#00e5ff]/25 bg-[#040d24]/85 px-2.5 py-1 shadow-[0_0_12px_rgba(0,229,255,0.2)] backdrop-blur"
          role="status"
          aria-live="polite"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${pill.dot}`} />
          <span className="text-[10px] font-bold uppercase tracking-widest text-[#d8fbff]">
            {pill.label}
          </span>
          {state === "recording" && (
            <span className="text-[10px] font-semibold text-[#9dd8ff] tabular-nums">
              {dimensions.width}×{dimensions.height}
            </span>
          )}
        </div>
      )}

      {/* Error detail — tiny pill with the reason (still non-interactive;
          the recording simply failed and gameplay is unaffected). */}
      {state === "error" && error && (
        <div className="pointer-events-none fixed bottom-14 right-4 z-[60] max-w-[240px] rounded-lg border border-red-400/30 bg-[#040d24]/95 px-2.5 py-1.5 text-[10px] leading-snug text-red-300 shadow-lg backdrop-blur">
          {error}
        </div>
      )}

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
