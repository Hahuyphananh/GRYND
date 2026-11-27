// src/lib/adcash/config.ts
//
// THE ONE PLACE THE ADCASH BANNER IS CONFIGURED.
//
// ── ISOLATION ─────────────────────────────────────────────────────────────
//
// This module is independent of HilltopAds (src/lib/hilltop/*), ExoClick
// (src/lib/exoclick/*) and AdSense (src/lib/ads.ts). It reads only ADCASH_*
// variables, and none of the other providers imports it.
//
// ── THE PROVIDER'S DISPLAY ZONE ───────────────────────────────────────────
//
// Adcash issues two snippets for a Display zone: the library and the zone
// script. The zone script is the documented asynchronous render call
// (https://support.adcash.com/en/articles/383):
//
//   <script src="<ADCASH_LIBRARY_URL>"></script>
//   <script>
//     aclib.runBanner({
//       zoneId: '<ZONE_ID>',
//       renderIn: '#<CONTAINER_ID>'
//     });
//   </script>
//
// `renderIn` is a querySelector for the element the banner must be drawn
// inside. GRYND supplies that element, so the creative lands in our container
// rather than wherever the provider's default parent happens to be.
//
// The zone id and the library URL are account values: neither has a default,
// and no publisher identifier or provider parameter is invented here. A missing
// value means the banner renders NOTHING.
//
// ── WHY THIS ONLY SUPPORTS DISPLAY BANNERS ───────────────────────────────
//
// `aclib.runBanner` is the Display format. Pop-under (`runPop`), Autotag
// (`runAutoTag`), Interstitial, In-Page Push and Video Slider are separate
// formats with separate calls. This module never references them, never loads
// an anti-adblock script, and never navigates the page. Choosing a Display
// zone is an operator step documented in docs/adcash-deployment.md.
//
// ── CONFIGURATION (exact names) ───────────────────────────────────────────
//
//   NEXT_PUBLIC_ADCASH_ENABLED              build-time switch. Opt-in:
//                                          "true"/"1" only.
//   ADCASH_ENABLED                          server, read per request. Same rule.
//   NEXT_PUBLIC_ADCASH_LIBRARY_URL          REQUIRED. The Adcash library URL
//                                          copied from the publisher panel.
//   NEXT_PUBLIC_ADCASH_ZONE_<PLACEMENT>     REQUIRED. The numeric display zone.
//   NEXT_PUBLIC_ADCASH_BANNER_SIZE          optional: 300x250 (default) or
//                                          728x90.
//   NEXT_PUBLIC_ADCASH_BANNER_SIZE_<PLACEMENT> optional per-placement size.
//   NEXT_PUBLIC_ADCASH_REQUIRES_CONSENT     defaults to true.
//
// Everything is opt-in and fails closed.

import { rotationOffset } from "../ads/core/order";

/** Hosts an Adcash library URL may use. */
export const ADCASH_PROVIDER_HOSTS = ["acscdn.com", "adcash.com"] as const;

/** The container GRYND owns; `renderIn` points the provider at it. */
export const ADCASH_CONTAINER_PREFIX = "grynd-adcash-banner";

/** Marks the library element, so a remount can never load it twice. */
export const ADCASH_LIBRARY_ATTRIBUTE = "data-grynd-adcash-library";

/** Marks the container the provider was told to render into. */
export const ADCASH_ZONE_ATTRIBUTE = "data-grynd-adcash-zone";

/** How long a blocked or unfilled request may hold the reserved area. */
export const ADCASH_READY_TIMEOUT_MS = 8_000;

/** Reserved heights for the supported display dimensions. */
export const ADCASH_RESERVED_HEIGHTS = Object.freeze({
  "300x250": 250,
  "728x90": 90,
} as const);

export type AdcashBannerSize = keyof typeof ADCASH_RESERVED_HEIGHTS;

/**
 * The browsing surfaces this banner may appear on — the same approved pages
 * as the existing banner architecture. Never a lobby below its own URL, a
 * match, a board, a live queue or the post-match overlay.
 */
export const ADCASH_PLACEMENTS = ["home", "hub", "leaderboard", "profile"] as const;

export type AdcashPlacement = (typeof ADCASH_PLACEMENTS)[number];

export function isAdcashPlacement(value: unknown): value is AdcashPlacement {
  return (
    typeof value === "string" &&
    (ADCASH_PLACEMENTS as readonly string[]).includes(value)
  );
}

/** One exact route per placement, matching the other banner integrations. */
export const ADCASH_PLACEMENT_ROUTES: Readonly<
  Record<AdcashPlacement, readonly string[]>
> = Object.freeze({
  home: ["/"],
  hub: ["/games", "/casino"],
  leaderboard: ["/classement"],
  profile: ["/profil"],
});

/** True when `pathname` is exactly the route this placement may serve. */
export function adcashRouteMatchesPlacement(
  pathname: string | null | undefined,
  placement: unknown,
): boolean {
  if (!isAdcashPlacement(placement)) return false;
  if (typeof pathname !== "string") return false;

  const path = pathname.split(/[?#]/)[0];
  const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return ADCASH_PLACEMENT_ROUTES[placement].includes(normalized);
}

/** The container id the provider is told to render into. */
export function adcashContainerId(placement: AdcashPlacement): string {
  return `${ADCASH_CONTAINER_PREFIX}-${placement}`;
}

/**
 * Kill switch: ON unless an operator explicitly sets false/0/off/no.
 *
 * The account's real library URL and DISPLAY zone are built in below, so the
 * banner works after a deploy without a second configuration step. Every other
 * gate still applies: approved route only, no native shell, no GRYND PRO,
 * consent accepted, and the zone must be a numeric Display zone.
 */
function switchOn(value: string | undefined): boolean {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return true;
  return raw !== "false" && raw !== "0" && raw !== "off" && raw !== "no";
}

export function adcashBannerEnabled(): boolean {
  return switchOn(process.env.NEXT_PUBLIC_ADCASH_ENABLED);
}

export function adcashBannerEnabledOnServer(): boolean {
  return switchOn(process.env.ADCASH_ENABLED);
}

/**
 * Consent is required by default; the client unit only draws the banner after
 * the visitor's stored consent record says "accepted".
 */
export function adcashRequiresConsent(): boolean {
  return (
    (process.env.NEXT_PUBLIC_ADCASH_REQUIRES_CONSENT ?? "").trim().toLowerCase() !==
    "false"
  );
}

export function adcashConsentSatisfied(
  consent: "accepted" | "declined" | null | undefined,
): boolean {
  return consent === "accepted";
}

/** True for acscdn.com / adcash.com and their subdomains. */
export function isAdcashProviderHost(hostname: string | null | undefined): boolean {
  const host = (hostname ?? "").trim().toLowerCase();
  if (!host) return false;
  return ADCASH_PROVIDER_HOSTS.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

/**
 * Validate the library URL copied from the publisher panel. https only, an
 * approved Adcash host, no credentials, bounded length. Anything else resolves
 * to null so the banner renders NOTHING instead of loading a script we cannot
 * vouch for.
 */
export function normalizeAdcashLibraryUrl(value: string | null | undefined): string | null {
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
  if (!isAdcashProviderHost(parsed.hostname)) return null;
  if (parsed.username || parsed.password) return null;

  return parsed.toString();
}

/**
 * The account's Adcash library, as issued by the publisher panel. It is the
 * same script for every zone, and it is a public URL (it appears in the page
 * source), not a credential.
 */
export const ADCASH_DEFAULT_LIBRARY_URL = "https://acscdn.com/script/aclib.js";

/**
 * The Display zones issued for grynd.dedyn.io.
 *
 * Both are numeric DISPLAY zones on the same website (neither is an Autotag
 * zone), so either can serve any approved browsing surface. They are used as a
 * pool: the first is the fallback and each opportunity rotates through them,
 * which spreads requests across both zones instead of hard-coding a
 * per-page guess about which zone "belongs" to which page. A per-placement
 * `NEXT_PUBLIC_ADCASH_ZONE_*` override always wins.
 */
export const ADCASH_ZONE_IDS = ["12500178", "12500186"] as const;

/** The fallback when no rotation key is supplied. */
export const ADCASH_DEFAULT_ZONE_ID = ADCASH_ZONE_IDS[0];

/**
 * The library URL this deploy will load, or null.
 *
 * An explicit but invalid override fails closed (null) rather than silently
 * falling back to the built-in script: a typo must not look configured.
 */
export function adcashLibraryUrl(): string | null {
  const raw = (process.env.NEXT_PUBLIC_ADCASH_LIBRARY_URL ?? "").trim();
  if (!raw) return normalizeAdcashLibraryUrl(ADCASH_DEFAULT_LIBRARY_URL);
  return normalizeAdcashLibraryUrl(raw);
}

// Static `process.env.NEXT_PUBLIC_*` reads only: Next inlines these at build
// time, so a dynamic lookup would be undefined in the browser.

function rawZoneValue(placement: AdcashPlacement): string | undefined {
  switch (placement) {
    case "home":
      return process.env.NEXT_PUBLIC_ADCASH_ZONE_HOME;
    case "hub":
      return process.env.NEXT_PUBLIC_ADCASH_ZONE_HUB;
    case "leaderboard":
      return process.env.NEXT_PUBLIC_ADCASH_ZONE_LEADERBOARD;
    case "profile":
      return process.env.NEXT_PUBLIC_ADCASH_ZONE_PROFILE;
    default:
      return undefined;
  }
}

/**
 * True for an Adcash AUTOTAG zone id, which looks like `zt2ub7mrao`.
 *
 * Autotag is deliberately NOT supported. Adcash documents it as a 4-in-1 tag
 * that rotates Pop-Under, Interstitial, In-Page Push and Video Slider — three
 * formats this product prohibits (no popunder, no push, no unexpected
 * interstitial). A zone id in this shape pasted into a DISPLAY variable is
 * refused, not guessed at, because `aclib.runBanner` only takes a numeric
 * Display zone.
 */
export function isAdcashAutotagZoneId(value: string | null | undefined): boolean {
  return /^zt[a-z0-9]{4,30}$/i.test((value ?? "").trim());
}

/**
 * The numeric DISPLAY zone id for a placement, or null. Never invented, and an
 * Autotag zone id (`zt…`) is always null — see `isAdcashAutotagZoneId`.
 */
export function adcashZoneId(placement: unknown, rotationKey?: string): string | null {
  if (!isAdcashPlacement(placement)) return null;
  const trimmed = (rawZoneValue(placement) ?? "").trim();
  // An explicit value must be a numeric Display zone: an Autotag id or junk
  // fails closed, never silently replaced by a pool zone.
  if (trimmed) {
    if (isAdcashAutotagZoneId(trimmed)) return null;
    return /^\d{1,20}$/.test(trimmed) ? trimmed : null;
  }
  const offset = rotationOffset(rotationKey ?? placement, ADCASH_ZONE_IDS.length);
  return ADCASH_ZONE_IDS[offset];
}

function rawSizeValue(placement: AdcashPlacement): string | undefined {
  switch (placement) {
    case "home":
      return process.env.NEXT_PUBLIC_ADCASH_BANNER_SIZE_HOME;
    case "hub":
      return process.env.NEXT_PUBLIC_ADCASH_BANNER_SIZE_HUB;
    case "leaderboard":
      return process.env.NEXT_PUBLIC_ADCASH_BANNER_SIZE_LEADERBOARD;
    case "profile":
      return process.env.NEXT_PUBLIC_ADCASH_BANNER_SIZE_PROFILE;
    default:
      return undefined;
  }
}

/** The container size this placement reserves. Defaults to 300x250. */
export function adcashBannerSize(placement: unknown): AdcashBannerSize {
  if (!isAdcashPlacement(placement)) return "300x250";
  const raw = (
    (rawSizeValue(placement) ?? "").trim() ||
    (process.env.NEXT_PUBLIC_ADCASH_BANNER_SIZE ?? "").trim()
  ).toLowerCase();
  return raw === "728x90" ? "728x90" : "300x250";
}

export function adcashReservedHeight(placement: unknown): number {
  return ADCASH_RESERVED_HEIGHTS[adcashBannerSize(placement)];
}

export function adcashContainerMaxWidth(placement: unknown): number {
  return adcashBannerSize(placement) === "300x250" ? 300 : 728;
}

/** True only when the placement, its zone id and the library URL all exist. */
export function adcashBannerConfigured(placement: unknown): boolean {
  return (
    isAdcashPlacement(placement) &&
    adcashLibraryUrl() !== null &&
    adcashZoneId(placement) !== null
  );
}

export function adcashBannerAllowed({
  enabled,
  configured,
  placement,
}: {
  enabled: boolean;
  configured: boolean;
  placement: unknown;
}): boolean {
  return enabled && configured && isAdcashPlacement(placement);
}

export function adcashBannerVisibleToViewer({
  allowed,
  adFree,
}: {
  allowed: boolean;
  adFree: boolean;
}): boolean {
  return allowed && !adFree;
}

/** The key that makes `runBanner` at most once per zone per document. */
export function adcashRunKey(placement: AdcashPlacement, zoneId: string): string {
  return `${placement}:${zoneId}`;
}

/** True when this zone has not been executed yet in this document. */
export function shouldRunAdcashZone(
  executed: ReadonlySet<string>,
  key: string,
): boolean {
  return !executed.has(key);
}
