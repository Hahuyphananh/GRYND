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
//   * NEXT_PUBLIC_HILLTOPS_ENABLED=false removes this provider from the chain
//     only. The other providers keep their own switches.
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
  "https://rude-movie.com/d/m.FUzldXGIN/vdZ-GvUr/XedmP9mu/ZGUMlSk/PLT/cV1/NQj-UfzGOJD/UytXNJzEUL2qNxTJMM4/O/Qd";

/**
 * THE MASTER SWITCH for the post-match video surface.
 *
 * `NEXT_PUBLIC_POST_MATCH_ADS_ENABLED=false` disables ALL post-match
 * advertising without touching a game or result screen. It deliberately does
 * NOT read a provider switch: with a provider chain, switching one provider
 * off must leave the other eligible providers untouched.
 */
export function postMatchAdsEnabled(): boolean {
  return (
    (process.env.NEXT_PUBLIC_POST_MATCH_ADS_ENABLED ?? "").trim().toLowerCase() !==
    "false"
  );
}

/**
 * Consent gate for the post-match video surface
 * (`NEXT_PUBLIC_POST_MATCH_ADS_REQUIRES_CONSENT`).
 *
 * Default ON. A VAST request is a non-essential advertising request, so it may
 * not leave the browser until the shared consent record says `accepted`. Set
 * this to `false` only for a property that has a documented legal basis for
 * pre-consent video advertising; the default must stay on for a CMP/TCF deploy.
 */
export function postMatchAdsRequireConsent(): boolean {
  return (
    (process.env.NEXT_PUBLIC_POST_MATCH_ADS_REQUIRES_CONSENT ?? "")
      .trim()
      .toLowerCase() !== "false"
  );
}

/** The shared consent record's accepted state, and nothing looser. */
export function postMatchConsentSatisfied(
  consent: "accepted" | "declined" | null | undefined,
): boolean {
  return consent === "accepted";
}

/**
 * HilltopAds' own switch (`NEXT_PUBLIC_HILLTOPS_ENABLED=false`). It removes only
 * this provider from the chain; the master switch above still governs the
 * surface.
 */
export function hilltopVideoProviderEnabled(): boolean {
  return (
    (process.env.NEXT_PUBLIC_HILLTOPS_ENABLED ?? "").trim().toLowerCase() !==
    "false"
  );
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
