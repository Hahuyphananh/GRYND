"use client";

// src/components/creator-mode/CreatorModeResultPanel.jsx
//
// Clean result panel shown AFTER recording stops (never during gameplay).
// Presents the locally-generated recording:
//
//   ✓ Recording completed
//   • selected dimensions (e.g. 1080×1920) + duration + format
//   • in-page video preview with play/pause
//   • Download  — saves the local blob (grynd-{game}-{date}-{time}.webm)
//   • Discard   — deletes the recording from the browser (object URL
//     released; nothing was ever uploaded or stored)
//   • Record another game — discard + re-arm (or start immediately when
//     the game is still live)
//
// The recording stays 100% local: no upload, no database, no external
// service. MP4 (H.264 + AAC) is preferred when the browser can record it
// (Chrome/Safari); browsers that only record WebM (Firefox) fall back
// gracefully — no FFmpeg-style transcoding dependency is added.
//
// Z-index note: this panel renders above the games' shared end-of-match
// overlay (PvpResultScreen is z-[95]) so the Download action stays
// reachable after a match auto-stops the recording.

import React, { useRef, useState } from "react";

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Human format label from a MediaRecorder mime type (e.g. WEBM / MP4). */
function formatLabel(mimeType) {
  if (!mimeType) return "WEBM";
  if (mimeType.includes("mp4")) return "MP4";
  return "WEBM";
}

function VideoPreview({ url }) {
  const videoRef = useRef(null);
  const [playing, setPlaying] = useState(false);

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play()
        .then(() => setPlaying(true))
        .catch(() => setPlaying(false));
    } else {
      v.pause();
      setPlaying(false);
    }
  };

  return (
    <div className="relative overflow-hidden rounded-xl border border-[#00e5ff]/25 bg-black">
      <video
        ref={videoRef}
        src={url}
        playsInline
        preload="metadata"
        className="block max-h-[42vh] w-full object-contain"
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        aria-label="Recording preview"
      />
      {/* Play / pause — centered, dismissible hover style */}
      <button
        onClick={toggle}
        aria-label={playing ? "Pause preview" : "Play preview"}
        className="absolute inset-0 m-auto flex h-14 w-14 items-center justify-center rounded-full border border-white/30 bg-black/60 text-white shadow-[0_0_20px_rgba(0,0,0,0.6)] transition hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
      >
        {playing ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>
    </div>
  );
}

export default function CreatorModeResultPanel({
  result,
  selectedDimensions,
  gameEnded,
  onDownload,
  onDiscard,
  onRecordAnother,
}) {
  const dims = result.dimensions || selectedDimensions;
  const format = formatLabel(result.mimeType);

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onDiscard} />

      <div className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-[#00e5ff]/30 bg-gradient-to-b from-[#0a1533] to-[#040d24] p-5 shadow-[0_0_60px_rgba(0,229,255,0.25)] sm:p-6">
        {/* Header */}
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-extrabold text-emerald-300">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/20 text-sm">
                ✓
              </span>
              Recording completed
            </h2>
            <p className="mt-1 text-xs text-[#9dd8ff]">
              Saved locally in your browser — never uploaded.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <span className="rounded-md bg-[#00e5ff]/15 px-2 py-0.5 text-[10px] font-bold tracking-wider text-[#00e5ff] tabular-nums">
              {dims.width}×{dims.height}
            </span>
            <span className="rounded-md bg-white/5 px-2 py-0.5 text-[10px] font-bold tracking-wider text-[#9dd8ff] tabular-nums">
              {formatDuration(result.durationMs)} · {format}
            </span>
          </div>
        </div>

        {/* Video preview with play/pause */}
        <VideoPreview url={result.url} />

        {/* Local-format note (MP4 preferred — no transcoding added) */}
        <p className="mt-2 text-[10px] leading-relaxed text-[#6aa4d8]">
          {format === "MP4"
            ? "MP4 (H.264 + AAC) — plays everywhere: Windows, Mac, phones, YouTube, Discord."
            : "WebM (VP9/Opus) — this browser only records WebM; plays in most apps."}
        </p>

        {/* Actions */}
        <div className="mt-3 flex flex-col gap-2">
          <button
            onClick={onDownload}
            className="w-full rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-bold text-black shadow-[0_0_20px_rgba(16,185,129,0.4)] transition hover:bg-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f5ff3b]"
          >
            ⬇ Download recording
          </button>
          <div className="flex gap-2">
            <button
              onClick={onRecordAnother}
              className="flex-1 rounded-xl border border-[#00e5ff]/40 bg-[#00e5ff]/10 px-4 py-2 text-sm font-bold text-[#00e5ff] transition hover:bg-[#00e5ff]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]"
            >
              ● Record another game
            </button>
            <button
              onClick={onDiscard}
              className="flex-1 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm font-bold text-red-300 transition hover:bg-red-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
            >
              Discard
            </button>
          </div>
          <p className="text-center text-[10px] text-[#6aa4d8]">
            {gameEnded
              ? "This game has ended — Creator Mode stays armed for your next game."
              : "The game is still live — recording can start again right away."}
          </p>
        </div>
      </div>
    </div>
  );
}
