// src/lib/profileCosmetics.ts
//
// Shared definitions for the Grynd+ profile customization suite.
//
//   * ACCENT_COLORS — the profile accent palette (also accepts any #RRGGBB
//     via the picker). Stored on `users.profile_accent`.
//
// Only writable by active Grynd+ members (enforced in
// /api/user/profile-customization).

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
