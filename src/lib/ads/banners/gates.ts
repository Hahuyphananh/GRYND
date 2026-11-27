// src/lib/ads/banners/gates.ts
//
// The pure visibility decision for the unified banner surface.
//
// Kept separate from the React server component so the four independent
// answers — native shell, approved placement, at least one configured provider,
// and the server-authoritative ad-free entitlement — can be tested directly.

import { isBannerPlacement } from "../core/types";
import type { AdProviderId } from "../core/types";

export interface BannerSurfaceInput {
  native: boolean;
  placement: unknown;
  providers: readonly AdProviderId[];
  adFree: boolean;
}

/**
 * True only when a free, non-native viewer is on an approved placement and at
 * least one provider is enabled and configured.
 */
export function bannerSurfaceAllowed({
  native,
  placement,
  providers,
  adFree,
}: BannerSurfaceInput): boolean {
  return (
    !native &&
    isBannerPlacement(placement) &&
    providers.length > 0 &&
    !adFree
  );
}
