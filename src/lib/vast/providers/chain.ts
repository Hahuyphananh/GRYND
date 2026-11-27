// src/lib/vast/providers/chain.ts
//
// Video eligibility and outcome mapping for the shared chain.
//
// `NEXT_PUBLIC_ADS_VIDEO_ORDER` sets priority. A provider appears only when its
// own switch is on AND it has a valid tag; a disabled provider is never
// requested. The global post-match switch is folded into each adapter's
// `enabled`, so it still disables the whole surface.

import { rotatedProviderOrder, videoProviderOrder } from "../../ads/core/order";
import type { AdOutcome, AdProviderId } from "../../ads/core/types";
import { VIDEO_AD_PLACEMENT } from "./config";
import type { VideoAdFailureReason, VideoProviderId } from "./types";
import { VIDEO_PROVIDERS } from "./index";

/**
 * Ordered providers that could actually answer a request right now.
 *
 * When an opportunity id is supplied the eligible order is rotated by it, so
 * two configured video providers alternate between matches instead of the
 * first one taking every request. The rotation is stable for the same id, so a
 * remount cannot reorder an in-flight chain.
 */
export function videoProviderChain(opportunityId?: string): VideoProviderId[] {
  const configured = new Set(
    VIDEO_PROVIDERS.filter((provider) => {
      const config = provider.config();
      return (
        config.enabled &&
        config.configured &&
        config.tagUrl !== null &&
        config.placement === VIDEO_AD_PLACEMENT
      );
    }).map((provider) => provider.id),
  );

  const eligible = videoProviderOrder().filter((id) =>
    configured.has(id),
  ) as VideoProviderId[];

  return opportunityId
    ? (rotatedProviderOrder(eligible, opportunityId) as VideoProviderId[])
    : eligible;
}

/**
 * Maps a typed adapter failure to a chain outcome.
 *
 * `no-ad`/`empty` is a real no-fill; a refused Wrapper/VPAID or an unplayable
 * creative is an invalid response; transport failures and timeouts stay
 * distinct. Every value is recoverable by falling through to the next provider.
 */
export function videoFailureOutcome(
  provider: AdProviderId,
  reason: VideoAdFailureReason,
): AdOutcome {
  const base = { provider, verifiedImpression: false, reason };

  switch (reason) {
    case "disabled":
    case "not-configured":
    case "placement-not-allowed":
      return { ...base, status: "provider_disabled" };
    case "timeout":
      return { ...base, status: "timeout" };
    case "aborted":
      return { ...base, status: "blocked", reason: "aborted" };
    case "no-ad":
    case "empty":
      return { ...base, status: "no_fill" };
    case "http-error":
    case "network-error":
    case "busy":
      return { ...base, status: "network_error" };
    case "oversized":
    case "malformed":
    case "unsafe-markup":
    case "wrapper-unsupported":
    case "vpaid-unsupported":
    case "no-linear":
    case "no-media":
      return { ...base, status: "invalid_response" };
  }
}
