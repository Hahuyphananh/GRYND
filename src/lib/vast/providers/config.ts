// src/lib/vast/providers/config.ts
//
// Shared configuration rules for the post-match video providers.
//
// Each provider supplies its OWN tag URL. ExoClick and Adcash have no default
// tag: their dashboard issues one per video zone, and inventing a URL would
// request inventory that is not ours. They are disabled until an operator opts
// in AND supplies the tag.
//
// The master switch is still `NEXT_PUBLIC_POST_MATCH_ADS_ENABLED=false`, which
// removes the whole video surface. The runtime switch `POST_MATCH_ADS_ENABLED`
// remains on the server route (src/app/api/ads/post-match/route.ts).

export const VIDEO_AD_PLACEMENT = "post-match" as const;

/**
 * The VAST tag issued for grynd.dedyn.io by youradexchange.com.
 *
 * It is a real, account-specific tag supplied by the operator, not a guess,
 * and it returns VAST 4.0. It is a VIDEO tag only — there is no display zone
 * behind it — and it is used on the post-match surface alone.
 */
export const ADEXCHANGE_VAST_TAG =
  "https://youradexchange.com/video/select.php?r=12500162";

/** Deadline bounds. Short enough that a failed tag never traps the player. */
export const DEFAULT_VIDEO_TIMEOUT_MS = 4_000;
export const MIN_VIDEO_TIMEOUT_MS = 1_000;
export const MAX_VIDEO_TIMEOUT_MS = 8_000;

/** Opt-in switch: only an explicit "true" / "1" turns anything ON. */
export function videoSwitchOn(value: string | undefined): boolean {
  const raw = (value ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1";
}

/** The global post-match kill switch. Unset means enabled, as today. */
export function videoAdsGloballyEnabled(): boolean {
  return (
    (process.env.NEXT_PUBLIC_POST_MATCH_ADS_ENABLED ?? "").trim().toLowerCase() !==
    "false"
  );
}

/** Clamp a configured timeout; an unparsable value falls back to 4 s. */
export function videoTimeoutMs(raw: string | undefined): number {
  const value = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(value)) return DEFAULT_VIDEO_TIMEOUT_MS;
  return Math.min(MAX_VIDEO_TIMEOUT_MS, Math.max(MIN_VIDEO_TIMEOUT_MS, value));
}

/**
 * Validate a provider-generated VAST tag URL.
 *
 * https only, no credentials, parsable, bounded length. The string is returned
 * unmodified (apart from upgrading a protocol-relative value to https), so the
 * provider's own query string and path survive exactly. There is no host
 * allow-list because the creative/tag host is provider- and account-specific;
 * the security boundary is https + the parser's own URL rules.
 */
export function normalizeVideoTagUrl(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw || raw.length > 2_048) return null;

  const absolute = raw.startsWith("//") ? `https:${raw}` : raw;

  let parsed: URL;
  try {
    parsed = new URL(absolute);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  if (parsed.username || parsed.password) return null;

  return absolute;
}

/**
 * True only for the post-match surface. A browsing page, a lobby, a live match
 * or the in-game board is never a valid video placement.
 */
export function videoProviderAllowsPlacement(placement: unknown): boolean {
  return placement === VIDEO_AD_PLACEMENT;
}
