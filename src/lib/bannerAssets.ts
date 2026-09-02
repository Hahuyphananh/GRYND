// src/lib/bannerAssets.ts
//
// Client-safe helpers for official Grynd profile banners. Banner artwork is
// resolved from this allow-listed catalog, never from a client-supplied URL,
// filename, filesystem path, or database id. The actual files may be added
// later; consumers must handle a missing image with a visual fallback.

export const BANNER_ASSET_DIR = "/banners";
export const BANNER_ASSET_EXT = "webp";
export const BANNER_KEY_MAX_LENGTH = 120;
export const BANNER_KEY_REGEX = /^[a-z0-9][a-z0-9._-]{0,119}$/;

// This client-safe catalog mirrors the trusted rows seeded by migration.
// It is deliberately small until artwork is supplied and more banners are approved.
export const OFFICIAL_BANNER_DEFINITIONS = [
  {
    key: "neon-grid",
    name: "Neon Grid",
    description: "A clean electric grid for your Grynd profile.",
    assetPath: "/banners/neon-grid.webp",
    rarity: "Common",
    enabled: true,
    sortOrder: 1,
  },
] as const;

const OFFICIAL_BANNER_ASSET_PATHS: Record<string, string> = Object.fromEntries(
  OFFICIAL_BANNER_DEFINITIONS.map((banner) => [banner.key, banner.assetPath]),
);

export function isBannerKey(value: unknown): value is string {
  return typeof value === "string" && BANNER_KEY_REGEX.test(value);
}

export function normalizeBannerKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return isBannerKey(normalized) && OFFICIAL_BANNER_ASSET_PATHS[normalized]
    ? normalized
    : null;
}

/** Resolve only an approved official key; invalid or unknown keys return null. */
export function bannerAssetUrl(value: unknown): string | null {
  const key = normalizeBannerKey(value);
  return key ? OFFICIAL_BANNER_ASSET_PATHS[key] : null;
}

/** Safe display helper for a stored/equipped banner key. */
export function resolveDisplayBannerKey(value: unknown): string | null {
  return normalizeBannerKey(value);
}

export function isTrustedBannerAssetUrl(value: unknown): boolean {
  return (
    typeof value === "string" &&
    Object.values(OFFICIAL_BANNER_ASSET_PATHS).includes(value)
  );
}
