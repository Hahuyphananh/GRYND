// src/lib/emoteAssets.ts
//
// Client-safe helpers for the official Grynd animated emotes. Emote artwork
// is resolved ONLY from this allow-listed catalog — never from a
// client-supplied URL, filename, filesystem path, or database id. Unknown /
// disabled / malformed keys resolve to null so consumers can skip the emote
// or render a safe fallback (never an arbitrary image).
//
// The 15 keys below mirror the trusted rows seeded by migration
// 0138_animated_emotes.sql. To point the system at different artwork, drop
// your animated WebP files at public/emotes/<key>.webp — or, if your file
// names differ, change the keys here AND in the migration seed (one row per
// emote), keeping this list in sync with the `emotes` catalog table.
//
// GG and NICE MOVE are NOT part of this catalog: they are permanent text
// system emotes rendered by the EmotePicker directly.

export const EMOTE_ASSET_DIR = "/emotes";
export const EMOTE_ASSET_EXT = "webp";
export const EMOTE_KEY_MAX_LENGTH = 120;
export const EMOTE_KEY_REGEX = /^[a-z0-9][a-z0-9._-]{0,119}$/;

/** Maximum number of animated emotes a player may equip at once. */
export const MAX_EQUIPPED_EMOTES = 9;

/**
 * The 8 FREE emotes — automatically owned + equipped (default loadout) for
 * every user. Granting is idempotent; a user never has to claim them.
 * ORDER MATTERS: it doubles as the default loadout order (first 8).
 */
export const FREE_EMOTE_KEYS = [
  "laugh",
  "shock",
  "cry",
  "angry",
  "love",
  "cool",
  "wow",
  "fire",
] as const;

/**
 * The full 15-entry official emote catalog (client-safe mirror of the
 * migration seed). 8 free entries + 7 Battle Pass entries.
 */
export const OFFICIAL_EMOTE_DEFINITIONS = [
  // ── FREE (8) — owned by every user ───────────────────────────────────
  {
    key: "laugh",
    name: "Laughing",
    description: "Burst out laughing with this animated Noto emote.",
    assetPath: "/emotes/laugh.webp",
    rarity: "Common",
    enabled: true,
    sortOrder: 1,
  },
  {
    key: "shock",
    name: "Shocked",
    description: "Wide-eyed surprise, animated.",
    assetPath: "/emotes/shock.webp",
    rarity: "Common",
    enabled: true,
    sortOrder: 2,
  },
  {
    key: "cry",
    name: "Crying",
    description: "Let the tears flow.",
    assetPath: "/emotes/cry.webp",
    rarity: "Common",
    enabled: true,
    sortOrder: 3,
  },
  {
    key: "angry",
    name: "Angry",
    description: "Steam coming off your head.",
    assetPath: "/emotes/angry.webp",
    rarity: "Common",
    enabled: true,
    sortOrder: 4,
  },
  {
    key: "love",
    name: "Love",
    description: "Hearts for days.",
    assetPath: "/emotes/love.webp",
    rarity: "Common",
    enabled: true,
    sortOrder: 5,
  },
  {
    key: "cool",
    name: "Cool",
    description: "Sunglasses. Zero worries.",
    assetPath: "/emotes/cool.webp",
    rarity: "Common",
    enabled: true,
    sortOrder: 6,
  },
  {
    key: "wow",
    name: "Wow",
    description: "Mind. Blown.",
    assetPath: "/emotes/wow.webp",
    rarity: "Common",
    enabled: true,
    sortOrder: 7,
  },
  {
    key: "fire",
    name: "Fire",
    description: "Straight fire.",
    assetPath: "/emotes/fire.webp",
    rarity: "Common",
    enabled: true,
    sortOrder: 8,
  },
  // ── BATTLE PASS (7) — granted at levels 6 / 13 / 22 / 31 / 42 / 56 / 81 ──
  {
    key: "hype",
    name: "Hype",
    description: "Get hyped. Battle Pass Level 6 reward.",
    assetPath: "/emotes/hype.webp",
    rarity: "Common",
    enabled: true,
    sortOrder: 9,
  },
  {
    key: "victory",
    name: "Victory",
    description: "You win. Battle Pass Level 13 reward.",
    assetPath: "/emotes/victory.webp",
    rarity: "Bronze",
    enabled: true,
    sortOrder: 10,
  },
  {
    key: "party",
    name: "Party",
    description: "Let the party begin. Battle Pass Level 22 reward.",
    assetPath: "/emotes/party.webp",
    rarity: "Bronze",
    enabled: true,
    sortOrder: 11,
  },
  {
    key: "skull",
    name: "Skull",
    description: "Too soon. Battle Pass Level 31 reward.",
    assetPath: "/emotes/skull.webp",
    rarity: "Silver",
    enabled: true,
    sortOrder: 12,
  },
  {
    key: "thumbsup",
    name: "Thumbs Up",
    description: "Respect. Battle Pass Level 42 reward.",
    assetPath: "/emotes/thumbsup.webp",
    rarity: "Silver",
    enabled: true,
    sortOrder: 13,
  },
  {
    key: "clap",
    name: "Clap",
    description: "Slow clap to standing ovation. Level 56 reward.",
    assetPath: "/emotes/clap.webp",
    rarity: "Gold",
    enabled: true,
    sortOrder: 14,
  },
  {
    key: "star",
    name: "Star",
    description: "Legend status. Battle Pass Level 81 reward.",
    assetPath: "/emotes/star.webp",
    rarity: "Elite",
    enabled: true,
    sortOrder: 15,
  },
] as const;

const OFFICIAL_EMOTE_ASSET_PATHS: Record<string, string> = Object.fromEntries(
  OFFICIAL_EMOTE_DEFINITIONS.map((emote) => [emote.key, emote.assetPath])
);

/** True only for well-formed emote keys (does NOT check catalog existence). */
export function isEmoteKey(value: unknown): value is string {
  return typeof value === "string" && EMOTE_KEY_REGEX.test(value);
}

/**
 * Normalize an emote key: trim + lowercase, then require it to be both
 * well-formed AND present in the official allow-listed catalog. Unknown /
 * disabled artwork keys return null so callers can skip the emote safely.
 */
export function normalizeEmoteKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return isEmoteKey(normalized) && OFFICIAL_EMOTE_ASSET_PATHS[normalized] ? normalized : null;
}

/**
 * Resolve the official local asset path for an emote key. Only approved
 * catalog keys resolve; everything else (arbitrary URLs, path traversal,
 * unknown keys) returns null — never an external or attacker-chosen path.
 */
export function emoteAssetUrl(value: unknown): string | null {
  const key = normalizeEmoteKey(value);
  return key ? OFFICIAL_EMOTE_ASSET_PATHS[key] : null;
}

/** Safe display helper for a stored/equipped emote key. */
export function resolveDisplayEmoteKey(value: unknown): string | null {
  return normalizeEmoteKey(value);
}

/** True only for asset paths that belong to the official emote catalog. */
export function isTrustedEmoteAssetUrl(value: unknown): boolean {
  return typeof value === "string" && Object.values(OFFICIAL_EMOTE_ASSET_PATHS).includes(value);
}
