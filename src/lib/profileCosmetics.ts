// src/lib/profileCosmetics.ts
//
// Shared definitions for the Grynd+ profile customization suite.
//
//   * AVATAR_FRAME_OPTIONS — the whitelist of avatar frame styles (key → CSS
//     background). The frame is rendered as a gradient ring around the avatar
//     by src/components/AvatarFrame.tsx. Keys are stored on
//     `users.avatar_frame`; anything not in this map is treated as no frame.
//   * ACCENT_COLORS — the profile accent palette (also accepts any #RRGGBB
//     via the picker). Stored on `users.profile_accent`.
//
// Both are only writable by active Grynd+ members (enforced in
// /api/user/profile-customization).

export const AVATAR_FRAME_OPTIONS = {
  gold: { label: "Gold", background: "linear-gradient(135deg, #ffd700, #b8860b)" },
  emerald: { label: "Emerald", background: "linear-gradient(135deg, #34d399, #059669)" },
  fuchsia: { label: "Fuchsia", background: "linear-gradient(135deg, #f0abfc, #d946ef)" },
  crimson: { label: "Crimson", background: "linear-gradient(135deg, #f43f5e, #9f1239)" },
  royal: { label: "Royal", background: "linear-gradient(135deg, #a78bfa, #4f46e5)" },
  rainbow: {
    label: "Rainbow",
    background:
      "conic-gradient(from 0deg, #f43f5e, #facc15, #34d399, #22d3ee, #a78bfa, #f43f5e)",
  },
} as const;

export type AvatarFrameKey = keyof typeof AVATAR_FRAME_OPTIONS;

export function isAvatarFrameKey(value: unknown): value is AvatarFrameKey {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(AVATAR_FRAME_OPTIONS, value)
  );
}

/** Default profile accent (matches the site's primary neon cyan). */
export const DEFAULT_PROFILE_ACCENT = "#00e5ff";

export const ACCENT_COLORS = [
  DEFAULT_PROFILE_ACCENT,
  "#f5ff3b",
  "#34d399",
  "#f0abfc",
  "#fb923c",
  "#a78bfa",
  "#f43f5e",
  "#facc15",
  "#e2e8f0",
];

export const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;
