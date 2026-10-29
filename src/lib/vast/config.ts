// src/lib/vast/config.ts
//
// The ONE place the post-match video ad's provider values live.
//
// WHY A SEPARATE MODULE FROM lib/ads.ts
// `lib/ads.ts` is the AdSense model: a placement registry that
// tests/ad-model.test.mjs pins to non-game surfaces (`home | hub | leaderboard |
// profile`). The post-match video ad is a different provider, a different format
// and — critically — a different surface (a finished match, not a browsing
// page). Keeping its tag here means the AdSense registry, its entitlement gate
// and its tests are untouched, and this integration can be removed by deleting
// this directory plus one mount site.
//
// THE TAG IS CONFIGURATION, NOT A LITERAL IN THE COMPONENT
// `NEXT_PUBLIC_HILLTOPS_VAST_URL` overrides the approved tag for a deploy that
// needs to rotate it. Whatever the source, the value must be a plain https URL
// with no embedded credentials: a malformed value resolves to `null`, and the
// component then renders its "unavailable" state instead of requesting
// something we cannot vouch for. There is no default fallback to a different
// provider and no invented tag.
//
// TWO SWITCHES, BOTH IN CONFIGURATION
//   * NEXT_PUBLIC_POST_MATCH_ADS_ENABLED=false is the master kill switch: it
//     removes the entire post-match ad surface immediately (no card, no request,
//     no offer counted) without touching a single game or result screen.
//   * NEXT_PUBLIC_HILLTOPS_ENABLED=false disables this provider specifically.
// Either one being "false" means no advertising.
//
// Cadence (how OFTEN an ad may appear) lives in ./frequency.ts and is likewise
// environment-tunable, so experiments never require a game-logic change.

/**
 * The HilltopAds zone approved for post-match video, verbatim.
 *
 * The endpoint is User-Agent gated (a non-browser request gets HTTP 404), which
 * is why the fetch happens in the browser and not in a server route.
 */
export const HILLTOPS_VAST_TAG =
  "https://rude-movie.com/dQmLF.zNdWGBNlv/Z_GzUa/Detmq9Ju_ZjUElLkiPrTWcJ1PNejfUfz_O/DbUjtYNUzgU/2WNOTrMj4ZOMQu";

/**
 * The master feature flag. True only when neither the global ad switch nor the
 * provider switch is explicitly off.
 *
 * `NEXT_PUBLIC_POST_MATCH_ADS_ENABLED=false` disables ALL post-match
 * advertising; `NEXT_PUBLIC_HILLTOPS_ENABLED=false` disables this provider.
 * Both default to enabled, and are inlined at build time like every other
 * `NEXT_PUBLIC_*` value.
 */
export function postMatchAdsEnabled(): boolean {
  const master = (process.env.NEXT_PUBLIC_POST_MATCH_ADS_ENABLED ?? "")
    .trim()
    .toLowerCase();
  if (master === "false") return false;

  const provider = (process.env.NEXT_PUBLIC_HILLTOPS_ENABLED ?? "")
    .trim()
    .toLowerCase();
  return provider !== "false";
}

/**
 * The VAST tag for this deploy, or `null` when it is not a plain https URL.
 *
 * Rejected: anything that is not `https:` (no `javascript:`, no `data:`, no
 * mixed content), any URL carrying credentials, and any value that does not
 * parse. The string is returned unmodified — no rewriting, no query additions.
 */
export function postMatchVastUrl(): string | null {
  const raw = (
    process.env.NEXT_PUBLIC_HILLTOPS_VAST_URL ?? HILLTOPS_VAST_TAG
  ).trim();
  if (!raw || raw.length > 2048) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  if (parsed.username || parsed.password) return null;

  return raw;
}
