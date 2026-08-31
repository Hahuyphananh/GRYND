// src/lib/iconAssets.ts
//
// PURE, dependency-free helpers for resolving OFFICIAL Grynd icons.
// Importable from client components (mirrors src/lib/profileCosmetics.ts).
// A Grynd avatar is ALWAYS resolved as an official asset path derived from a
// key in the official catalog — never from an arbitrary user-supplied URL.
//
// Asset convention: an icon with catalog key `K` lives at `/icons/K.webp`.
// The DB `icons.asset_path` column stores this same stable path. If the
// artwork file does not exist yet (it will be added later, see
// public/icons/README.md), the ONLY consumer (`src/components/IconAvatar.tsx`)
// falls back to a letter avatar via its `onError` handler — resolution
// never depends on the file being present at build time.

/** The official default icon key. Every user owns + is equipped with it. */
export const DEFAULT_ICON_KEY = "default";

/** Directory the official Grynd icon assets are served from. */
export const ICON_ASSET_DIR = "/icons";

/** File extension used for official icon artwork. */
export const ICON_ASSET_EXT = "webp";

/**
 * Max length of an icon key — kept in sync with the `icons.key` /
 * `users.selected_icon` VARCHAR(120) columns.
 */
export const ICON_KEY_MAX_LENGTH = 120;

/**
 * Strict safe-format check for an icon key. Keys are only ever produced by
 * the official catalog; this guards every usage site so an attacker-supplied
 * key can never smuggle a path separator, `..`, or scheme into an `src`.
 */
export const ICON_KEY_REGEX = /^[a-z0-9][a-z0-9._-]{0,119}$/;

/** True only for well-formed icon keys (does NOT check catalog existence). */
export function isIconKey(value: unknown): value is string {
  return typeof value === "string" && ICON_KEY_REGEX.test(value);
}

const resolveKey = (key: unknown): string =>
  isIconKey(key) ? key : DEFAULT_ICON_KEY;

/**
 * Resolve the official asset URL for an icon key. Never trusts caller input:
 * anything malformed resolves to the official default icon. Callers that need
 * to render an icon (e.g. IconAvatar) should use this — never a stored URL.
 */
export function iconAssetUrl(key: unknown): string {
  return `${ICON_ASSET_DIR}/${resolveKey(key)}.${ICON_ASSET_EXT}`;
}

/** Official asset URL for the default icon. */
export function defaultIconAssetUrl(): string {
  return `${ICON_ASSET_DIR}/${DEFAULT_ICON_KEY}.${ICON_ASSET_EXT}`;
}

/**
 * Coerce a raw selected-icon value (e.g. from `users.selected_icon`) into a
 * safe, renderable key — falling back to the default on anything malformed.
 * Server read paths call this before exposing a user's icon.
 */
export function resolveDisplayIconKey(raw: unknown): string {
  return resolveKey(raw);
}