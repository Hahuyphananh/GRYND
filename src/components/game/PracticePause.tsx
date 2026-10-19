"use client";

// src/components/game/PracticePause.tsx
//
// The two visible pieces of the free-play pause, shared by every vs-AI match
// page so the control cannot drift per game:
//
//   <PracticePauseChip>     the Pause/Resume button in the match header
//   <PracticePauseOverlay>  the full-screen frozen state
//
// Both are deliberately presentational — the page owns `paused`/`busy` through
// `usePracticePause`.

import {
  IconPlayerPause,
  IconPlayerPlay,
} from "@tabler/icons-react";

export function PracticePauseChip({
  paused,
  busy,
  onToggle,
  className = "",
  testId,
}: {
  paused: boolean;
  busy: boolean;
  onToggle: () => void;
  className?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onToggle}
      disabled={busy}
      aria-pressed={paused}
      aria-label={paused ? "Resume practice match" : "Pause practice match"}
      className={
        className ||
        "inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-black/40 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-amber-200 transition hover:bg-amber-400/10 disabled:cursor-wait disabled:opacity-50"
      }
    >
      {paused ? <IconPlayerPlay size={14} /> : <IconPlayerPause size={14} />}
      {busy ? "…" : paused ? "Resume" : "Pause"}
    </button>
  );
}

export function PracticePauseOverlay({
  paused,
  busy,
  onResume,
  testId,
}: {
  paused: boolean;
  busy: boolean;
  onResume: () => void;
  testId?: string;
}) {
  if (!paused) return null;
  return (
    <div
      data-testid={testId}
      role="dialog"
      aria-modal="true"
      aria-label="Practice match paused"
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 px-6 backdrop-blur-md"
    >
      <div className="w-full max-w-sm rounded-3xl border border-amber-400/30 bg-[#120d05]/95 p-8 text-center shadow-2xl">
        <p className="text-[11px] font-black uppercase tracking-[0.4em] text-amber-400/80">
          Free play
        </p>
        <p className="mt-2 text-3xl font-black uppercase tracking-[0.28em] text-amber-200">
          Paused
        </p>
        <p className="mt-3 text-sm leading-relaxed text-amber-100/60">
          The bot and your clock are frozen. Nothing moves until you resume.
        </p>
        <button
          type="button"
          onClick={onResume}
          disabled={busy}
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-400 px-5 py-3 text-sm font-black uppercase tracking-[0.16em] text-black transition hover:bg-amber-300 disabled:cursor-wait disabled:opacity-60"
        >
          <IconPlayerPlay size={16} />
          {busy ? "Resuming…" : "Resume match"}
        </button>
      </div>
    </div>
  );
}

export default PracticePauseChip;
