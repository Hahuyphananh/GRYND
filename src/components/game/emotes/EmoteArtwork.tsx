"use client";

// src/components/game/emotes/EmoteArtwork.tsx
//
// Renders one emote: a word emote as text, an animated catalog emote as its
// official local asset. Asset resolution is allow-listed through
// emoteAssetUrl(key), so a value arriving from a socket can never reach an
// <img src>; unknown/missing keys render nothing (fail safe).
//
// Moved here unchanged in behaviour from the old EmotePicker so every surface
// (bar, wheel, bubble) draws an emote identically.

import { emoteAssetUrl } from "../../../lib/emoteAssets";
import type { EmotePayload } from "./useEmoteLoadout";

export default function EmoteArtwork({
  emote,
  imageClassName = "h-11 w-11",
  textClassName = "",
  onError = null,
}: {
  emote: EmotePayload;
  imageClassName?: string;
  textClassName?: string;
  onError?: (() => void) | null;
}) {
  if (!emote) return null;

  if (emote.kind === "word") {
    return (
      <span className={textClassName || "font-black tracking-tight"}>
        {emote.value}
      </span>
    );
  }

  const assetUrl = emoteAssetUrl(emote.key);
  if (!assetUrl) return null;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={assetUrl}
      alt=""
      aria-hidden="true"
      loading="lazy"
      draggable={false}
      className={`${imageClassName} object-contain select-none`}
      onError={(event) => {
        // Asset missing/disabled — hide it (fail safe, no broken image).
        event.currentTarget.style.display = "none";
        if (onError) onError();
      }}
    />
  );
}
