"use client";

// src/components/FrameAvatar.tsx
//
// IconAvatar wrapped in the player's equipped profile frame (token-shop
// `profile_frame` cosmetic). Every avatar surface that shows a frame — profile,
// leaderboards, chat, lobby, in-game seats — uses this so the ring is drawn
// identically everywhere.
//
// The frame payload is server-owned `{ key, name, visual }` (see
// src/lib/cosmetics.ts). When there is no frame the bare <IconAvatar> is
// returned, so unconsumed surfaces keep their exact previous markup/layout.

import IconAvatar from "./IconAvatar";
import { cosmeticFrameRing } from "../lib/profileCosmetics";

export type ProfileFramePayload = {
  key?: string;
  name?: string;
  visual?: unknown;
} | null;

/**
 * Frame ring as raw className/style, for surfaces that must draw the ring on
 * their OWN wrapper (e.g. an `overflow-hidden` avatar chip that would clip a
 * shadow on the inner <img>). Returns empty values when there is no frame.
 */
export function frameWrapperProps(frame?: ProfileFramePayload): {
  className: string;
  style: { boxShadow: string } | undefined;
} {
  const ring = cosmeticFrameRing(frame?.visual);
  return { className: ring.cssClass, style: ring.style };
}

export default function FrameAvatar({
  frame = null,
  iconKey,
  name,
  size = "h-14 w-14",
  className = "",
}: {
  /** Server-resolved profile frame (or null/undefined for none). */
  frame?: ProfileFramePayload;
  iconKey?: string | null;
  name?: string | null;
  size?: string;
  className?: string;
}) {
  const ring = cosmeticFrameRing(frame?.visual);
  const avatar = (
    <IconAvatar iconKey={iconKey} name={name} size={size} className={className} />
  );

  if (!ring.cssClass && !ring.style) return avatar;

  return (
    <span
      className={`inline-flex shrink-0 rounded-full ${ring.cssClass}`}
      style={ring.style}
      data-profile-frame={frame?.key || undefined}
    >
      {avatar}
    </span>
  );
}
