"use client";

// src/components/game/emotes/EmoteBubble.tsx
//
// One emote, as a speech bubble. Purely presentational: the caller decides
// WHERE it sits (the layer pins it to the top of the screen for the opponent
// and above your own controls for you), so the same bubble can later be
// anchored to a player card without changing this file.
//
// `side` still drives the colour language the app already uses:
//   incoming → fuchsia (opponent)      mine → cyan (you)
//
// An optional `label` names the sender, which is what fixes the old problem of
// not being able to tell whose reaction just appeared.

import EmoteArtwork from "./EmoteArtwork";
import type { EmotePayload } from "./useEmoteLoadout";

export default function EmoteBubble({
  emote,
  side = "incoming",
  label = null,
  className = "",
}: {
  emote: EmotePayload;
  side?: "incoming" | "mine";
  label?: string | null;
  className?: string;
}) {
  if (!emote) return null;

  const isMine = side === "mine";
  const accessibleLabel = isMine
    ? "Your emote"
    : label
      ? `${label} sent an emote`
      : "Opponent emote";

  return (
    <span
      role="status"
      aria-label={accessibleLabel}
      data-emote-bubble={isMine ? "mine" : "incoming"}
      className={`inline-flex max-w-[min(16rem,80vw)] items-center gap-2 rounded-2xl border bg-[#071531]/95 px-2.5 py-1.5 shadow-[0_0_18px_rgba(0,0,0,0.45)] backdrop-blur-md ${
        isMine
          ? "rounded-br-sm border-cyan-300/60 shadow-[0_0_18px_rgba(0,229,255,.35)]"
          : "rounded-bl-sm border-fuchsia-300/60 shadow-[0_0_18px_rgba(255,60,172,.35)]"
      } ${className}`}
    >
      {label ? (
        <span
          className={`max-w-[7rem] truncate text-[10px] font-bold uppercase tracking-[0.12em] ${
            isMine ? "text-cyan-200/80" : "text-fuchsia-200/80"
          }`}
        >
          {label}
        </span>
      ) : null}
      <EmoteArtwork
        emote={emote}
        imageClassName="h-8 w-8"
        textClassName="max-w-[9rem] text-center text-xs font-black leading-tight tracking-tight text-[#f5ff3b]"
      />
    </span>
  );
}
