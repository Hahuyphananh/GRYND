// src/lib/ads/core/types.ts
//
// The provider-neutral vocabulary shared by the banner chain and the post-match
// video chain.
//
// A provider result is deliberately NOT a boolean. "The script loaded" is not a
// fill, and "the request came back empty" is not an error: the chain needs to
// tell those apart so it can fall through on a real no-fill without ever
// claiming an impression it cannot verify.

export type AdKind = "banner" | "video";

export type AdProviderId = "hilltop" | "exoclick" | "adcash" | "adexchange";

export const AD_PROVIDERS: readonly AdProviderId[] = [
  "hilltop",
  "exoclick",
  "adcash",
  // VIDEO ONLY. The tag issued for grynd.dedyn.io on youradexchange.com is a
  // VAST endpoint; it has no display/zone API and never serves a banner. Banner
  // eligibility refuses it so it can never be attempted in the banner chain.
  "adexchange",
];

/**
 * The only outcomes a provider attempt may report.
 *
 *   filled            a creative is available (for video, a playable Inline ad)
 *   no_fill           the provider answered and had nothing to serve
 *   timeout           no answer within the attempt deadline
 *   blocked           consent, CSP, policy or a native shell refused the tag
 *   network_error     the tag or creative could not be fetched
 *   invalid_response  the response was unreadable, refused (Wrapper/VPAID) or
 *                     unusable (no playable media)
 *   provider_disabled switched off or missing required configuration
 */
export type AdOutcomeStatus =
  | "filled"
  | "no_fill"
  | "timeout"
  | "blocked"
  | "network_error"
  | "invalid_response"
  | "provider_disabled";

export interface AdOutcome {
  provider: AdProviderId;
  status: AdOutcomeStatus;
  /** True only when an impression was actually observed, never inferred. */
  verifiedImpression: boolean;
  /** Short, non-user-specific diagnostic. Never a URL with a query string. */
  reason?: string;
  latencyMs?: number;
}

/** A single placement request, identified so it can only be served once. */
export interface AdOpportunity {
  id: string;
  kind: AdKind;
  placement: string;
}

/** Placements the banner chain may serve. */
export const BANNER_PLACEMENTS = ["home", "hub", "leaderboard", "profile"] as const;

export type BannerPlacement = (typeof BANNER_PLACEMENTS)[number];

export function isBannerPlacement(value: unknown): value is BannerPlacement {
  return (
    typeof value === "string" &&
    (BANNER_PLACEMENTS as readonly string[]).includes(value)
  );
}

/** The one route each banner placement belongs to. */
export const BANNER_PLACEMENT_ROUTES: Readonly<
  Record<BannerPlacement, readonly string[]>
> = Object.freeze({
  home: ["/"],
  hub: ["/games", "/casino"],
  leaderboard: ["/classement"],
  profile: ["/profil"],
});

/** Exact-match route guard; a lobby, match, board or alias is in no list. */
export function bannerRouteMatchesPlacement(
  pathname: string | null | undefined,
  placement: unknown,
): boolean {
  if (!isBannerPlacement(placement)) return false;
  if (typeof pathname !== "string") return false;
  const path = pathname.split(/[?#]/)[0];
  const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return BANNER_PLACEMENT_ROUTES[placement].includes(normalized);
}
