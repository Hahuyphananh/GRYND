"use client";

// src/components/creator-mode/CreatorModeExteriorBar.jsx
//
// The Creator Mode control cluster (status + Stop & save + Download).
// CreatorModeOverlay renders it in a PORTAL at the bottom of the
// viewport — above the game's own UI, never inside the recording frame,
// and never captured. Portaling is what makes it reliable on every
// device: it cannot fall below the fold of a page layout, cannot be
// covered by page chrome or fixed bottom bars, and its clicks always
// land on the buttons.
//
// Both buttons are ALWAYS clickable — they never sit in a disabled,
// no-op state (a stale React state could previously leave a "disabled"
// Stop button even while the recorder was actually running, so clicks
// appeared to do nothing). Tapping a button always responds:
//   • Stop & Save while recording → ends the capture and auto-downloads
//     the finished file;
//   • Stop & Save with nothing recording → shows a short hint;
//   • Download when a finished clip exists → downloads it;
//   • Download with no clip yet → shows a short hint.
// The status label shows the live state: "Creator Mode armed" → REC +
// dimensions → "Saved — ready to download" (errors inline).

import React, { useEffect, useRef, useState } from "react";
import { useCreatorMode } from "../../lib/creator-mode/CreatorModeProvider";

// Tiny status pill content per recorder state. `stopped` is handled by
// the saved label below instead.
const STATE_LABEL = {
  idle: { dot: "bg-[#6aa4d8]", label: "Creator Mode armed" },
  requesting: { dot: "bg-amber-400 animate-pulse", label: "Preparing…" },
  recording: { dot: "bg-red-500 animate-pulse", label: "REC" },
  error: { dot: "bg-red-400", label: "Recording unavailable" },
};

function StopIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="shrink-0">
      <rect width="10" height="10" rx="1.5" fill="currentColor" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M12 3v11" />
      <path d="m6 10 6 6 6-6" />
      <path d="M4 20h16" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M8 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 8 5.5Z" />
    </svg>
  );
}

export default function CreatorModeExteriorBar() {
  const {
    state,
    error,
    lastResult,
    gameEnded,
    dimensions,
    countdown,
    startCreatorRecording,
    stopCreatorRecording,
    download,
  } = useCreatorMode();

  // ── Save on stop ───────────────────────────────────────────────────
  // A finished recording is auto-downloaded the moment the recorder
  // finalises it when (a) the game ended normally (auto-stop) or (b) the
  // user pressed the manual "Stop & save" button here in the bar. Each
  // result is downloaded at most once, guarded by its identity.
  const [manualStop, setManualStop] = useState(false);
  const autoSavedKeyRef = useRef(null);

  useEffect(() => {
    if (state === "recording") {
      // A new capture started — clear the guards for the upcoming result.
      setManualStop(false);
      autoSavedKeyRef.current = null;
      return;
    }
    if (state !== "stopped" || !lastResult) return;
    if (autoSavedKeyRef.current === lastResult) return;
    autoSavedKeyRef.current = lastResult;
    if (manualStop || gameEnded) {
      download();
    }
  }, [state, lastResult, gameEnded, manualStop, download]);

  // ── Transient hint shown when a button is tapped but has nothing to
  // act on yet — every tap must visibly respond. Auto-clears after 2.5s.
  const [notice, setNotice] = useState(null);
  const noticeTimerRef = useRef(null);
  const showNotice = (text) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setNotice(text);
    noticeTimerRef.current = setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, 2500);
  };
  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const pill = STATE_LABEL[state] || null;
  const recording = state === "recording";
  const hasClip = Boolean(lastResult);
  // Nothing recording, no clip, and no countdown running → offer to
  // start a capture manually (the auto-start may not have fired, or the
  // user simply wants to record now).
  const canStartManually = !recording && !hasClip && countdown === null;

  // "Stop & save": end the capture; the effect above auto-downloads the
  // finished file as soon as the recorder finalises it. Always enabled —
  // with nothing recording it shows a hint instead of silently no-oping.
  const stopAndSave = () => {
    if (!recording) {
      showNotice("No active recording yet — starts when the match begins");
      return;
    }
    setManualStop(true);
    stopCreatorRecording();
  };

  const onDownload = () => {
    const filename = download();
    if (!filename) {
      showNotice("No finished recording yet — stop or finish the match first");
    }
  };

  return (
    <div className="pointer-events-auto flex max-w-[calc(100vw-2rem)] flex-wrap items-center justify-center gap-x-4 gap-y-2 rounded-2xl border border-[#00e5ff]/30 bg-[#040d24]/95 px-4 py-2.5 shadow-[0_0_24px_rgba(0,229,255,0.2)] backdrop-blur">
      {/* Status label */}
      <span
        role="status"
        aria-live="polite"
        className="flex items-center gap-2"
      >
        <span
          className={`h-2 w-2 rounded-full ${
            state === "error"
              ? "bg-red-400"
              : state === "recording"
              ? "bg-red-500 animate-pulse"
              : state === "requesting"
              ? "bg-amber-400 animate-pulse"
              : pill?.dot || "bg-[#6aa4d8]"
          }`}
        />
        <span className="text-xs font-bold uppercase tracking-widest text-[#d8fbff] sm:text-sm">
          {state === "stopped"
            ? "Saved — ready to download"
            : state === "error"
            ? "Recording unavailable"
            : pill?.label || "Creator Mode armed"}
        </span>
        {state === "recording" && (
          <span className="text-xs font-bold text-[#9dd8ff] tabular-nums sm:text-sm">
            {dimensions.width}×{dimensions.height}
          </span>
        )}
      </span>

      {/* Start recording — shown whenever nothing is recording and no
          clip exists yet. Runs the same 3→2→1 countdown → capture flow
          as the automatic start, so recording can always begin even if
          the auto-start signal never arrived. */}
      {canStartManually && (
        <button
          type="button"
          onClick={() => startCreatorRecording()}
          title="Start recording now (3-second countdown)"
          className="flex cursor-pointer items-center gap-2 rounded-xl border-2 border-[#00e5ff]/70 bg-[#00e5ff]/15 px-4 py-2 text-xs font-extrabold uppercase tracking-wider text-[#7cefff] transition hover:bg-[#00e5ff]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[#040d24] focus-visible:ring-cyan-300 sm:text-sm"
        >
          <PlayIcon />
          Start Recording
        </button>
      )}

      {/* Stop & save — ALWAYS clickable. Ends the capture and
          auto-downloads the finished file; a hint appears if there is
          nothing recording yet. */}
      <button
        type="button"
        onClick={stopAndSave}
        title={
          recording
            ? "Stop recording and save the video"
            : "No active recording to stop"
        }
        className={`flex cursor-pointer items-center gap-2 rounded-xl border-2 px-4 py-2 text-xs font-extrabold uppercase tracking-wider transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[#040d24] sm:text-sm ${
          recording
            ? "border-red-400 bg-red-600 text-white shadow-[0_0_18px_rgba(239,68,68,0.55)] hover:bg-red-500 focus-visible:ring-red-300"
            : "border-red-400/50 bg-red-600/15 text-red-200 hover:bg-red-600/30 focus-visible:ring-red-300"
        }`}
      >
        <StopIcon />
        Stop &amp; Save
      </button>

      {/* Download — ALWAYS clickable. Downloads the finished clip, or
          shows a hint when there is no finished recording yet. */}
      <button
        type="button"
        onClick={onDownload}
        title={
          hasClip ? "Download the finished recording" : "No finished recording yet"
        }
        className={`flex cursor-pointer items-center gap-2 rounded-xl border-2 px-4 py-2 text-xs font-extrabold uppercase tracking-wider transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[#040d24] sm:text-sm ${
          hasClip
            ? "border-emerald-400 bg-emerald-600 text-white shadow-[0_0_18px_rgba(16,185,129,0.55)] hover:bg-emerald-500 focus-visible:ring-emerald-300"
            : "border-emerald-400/50 bg-emerald-600/15 text-emerald-200 hover:bg-emerald-600/30 focus-visible:ring-emerald-300"
        }`}
      >
        <DownloadIcon />
        Download
      </button>

      {/* Transient hint — a tap always produces a visible response. */}
      {notice && (
        <span
          role="status"
          aria-live="polite"
          className="text-xs font-semibold text-[#f5ff3b] sm:text-sm"
        >
          {notice}
        </span>
      )}

      {/* Error reason — compact; the recording simply failed and
          gameplay is unaffected. */}
      {state === "error" && error && (
        <span className="max-w-[280px] text-xs leading-snug text-red-300">
          {error}
        </span>
      )}
    </div>
  );
}
