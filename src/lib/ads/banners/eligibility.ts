// src/lib/ads/banners/eligibility.ts
//
// SERVER-SIDE ELIGIBILITY for the unified banner chain.
//
// The page has ONE slot. Before the response is written, this module answers
// which providers may compete for it, in configured priority order:
//
//   * the provider's runtime AND build-time switches are on,
//   * its placement has a real loader/zone/class (Hilltop additionally requires
//     the written provider attestation),
//   * the placement is one of the approved browsing surfaces.
//
// A provider that fails any check is simply absent, so the browser never loads
// its script and never treats "disabled" as a fallback error to recover from.
// Entitlement/native/consent are separate gates in BannerSlot / the client.

import {
  hilltopBannerAllowed,
  hilltopBannerEnabled,
  hilltopBannerEnabledOnServer,
  hilltopBannerScriptUrl,
  hilltopProviderAttested,
} from "../../hilltop/config";
import {
  exoclickBannerAllowed,
  exoclickBannerConfigured,
  exoclickBannerEnabled,
  exoclickBannerEnabledOnServer,
} from "../../exoclick/config";
import {
  adcashBannerAllowed,
  adcashBannerConfigured,
  adcashBannerEnabled,
  adcashBannerEnabledOnServer,
} from "../../adcash/config";
import { bannerProviderOrder, eligibleProviders } from "../core/order";
import type { AdProviderId } from "../core/types";

/** True when this provider may be attempted on this placement. */
export function bannerProviderEligible(
  id: AdProviderId,
  placement: unknown,
): boolean {
  switch (id) {
    case "hilltop":
      return hilltopBannerAllowed({
        enabled:
          hilltopBannerEnabledOnServer() &&
          hilltopBannerEnabled() &&
          hilltopProviderAttested(),
        configured: hilltopBannerScriptUrl() !== null,
        placement,
      });
    case "exoclick":
      return exoclickBannerAllowed({
        enabled: exoclickBannerEnabledOnServer() && exoclickBannerEnabled(),
        configured: exoclickBannerConfigured(placement),
        placement,
      });
    case "adcash":
      return adcashBannerAllowed({
        enabled: adcashBannerEnabledOnServer() && adcashBannerEnabled(),
        configured: adcashBannerConfigured(placement),
        placement,
      });
    case "adexchange":
      // Video only: its VAST tag has no display zone, so it is never a banner
      // candidate. Refusing it here keeps the banner chain honest rather than
      // treating a missing zone as a fallback failure.
      return false;
  }
}

/** The ordered, eligible providers for one placement. */
export function eligibleBannerProviders(placement: unknown): AdProviderId[] {
  return eligibleProviders(bannerProviderOrder(), (id) =>
    bannerProviderEligible(id, placement),
  );
}
