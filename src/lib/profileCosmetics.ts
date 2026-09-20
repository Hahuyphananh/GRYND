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

/**
 * A cosmetic's catalog `visual` payload (stored as jsonb on `cosmetics`).
 * `cssClass` is an optional named style shipped in globals.css; `color` is
 * the catalog hex used for the colored ring/glow fallback.
 */
export type CosmeticVisual = {
  cssClass: string | null;
  color: string | null;
};

/**
 * Defensively normalize a cosmetic's `visual` jsonb into renderable values.
 * Catalog rows are server-owned, but the jsonb column can hold anything —
 * this keeps arbitrary strings out of the rendered className/style. Shared by
 * the profile frame renderer and the frame picker so both agree on the look.
 */
export function normalizeCosmeticVisual(visual: unknown): CosmeticVisual {
  const raw =
    visual && typeof visual === "object" ? (visual as Record<string, unknown>) : {};
  const cssClass = typeof raw.cssClass === "string" ? raw.cssClass.trim() : "";
  const color = typeof raw.color === "string" ? raw.color.trim() : "";
  return {
    cssClass: cssClass || null,
    color: color || null,
  };
}

/**
 * Render recipe for a profile-frame cosmetic. A named `cssClass` (shipped in
 * globals.css, e.g. `frame-inferno`) owns the full frame look; frames without
 * one fall back to a colored ring built from the catalog hex. Every surface
 * that draws a frame uses this so the picker preview matches the real avatar.
 */
export type FrameRing = {
  cssClass: string;
  style: { boxShadow: string } | undefined;
};

export function cosmeticFrameRing(visual: unknown): FrameRing {
  const { cssClass, color } = normalizeCosmeticVisual(visual);
  return {
    cssClass: cssClass || "",
    style:
      !cssClass && color
        ? { boxShadow: `0 0 0 2px ${color}, 0 0 18px ${color}88` }
        : undefined,
  };
}
