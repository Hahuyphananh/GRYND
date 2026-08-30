"use client";

// src/components/AvatarFrame.tsx
//
// Wraps an avatar (image or letter-avatar) in a gradient ring when the user
// has a Grynd+ avatar frame set. Without a valid frame key it renders the
// children untouched, so callers keep their default styling. Frame keys are
// whitelisted in src/lib/profileCosmetics.ts — anything unknown is no frame.

import type { ReactNode } from "react";
import { AVATAR_FRAME_OPTIONS } from "../lib/profileCosmetics";

export default function AvatarFrame({
  frame,
  className = "",
  children,
}: {
  frame?: string | null;
  /** Size + shape classes applied to the ring wrapper (e.g. "h-14 w-14"). */
  className?: string;
  children: ReactNode;
}) {
  const def =
    frame && Object.prototype.hasOwnProperty.call(AVATAR_FRAME_OPTIONS, frame)
      ? AVATAR_FRAME_OPTIONS[frame as keyof typeof AVATAR_FRAME_OPTIONS]
      : null;

  if (!def) {
    return <>{children}</>;
  }

  return (
    <div
      className={`shrink-0 rounded-full p-[3px] ${className}`}
      style={{ background: def.background }}
    >
      {children}
    </div>
  );
}
