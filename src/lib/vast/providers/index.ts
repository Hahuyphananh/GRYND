// src/lib/vast/providers/index.ts
//
// The video provider registry.
//
// `VIDEO_PROVIDER_ORDER` is the default priority. The live order is
// `NEXT_PUBLIC_ADS_VIDEO_ORDER`, filtered by each adapter's enabled/configured
// state in ./chain.ts. `PostMatchVideoAd` requests them one at a time through
// `requestVideoAd(id)`; every adapter returns the same normalized result and
// never throws.

import { hilltopVideoProvider } from "./hilltop";
import { exoclickVideoProvider } from "./exoclick";
import { adcashVideoProvider } from "./adcash";
import { adexchangeVideoProvider } from "./adexchange";
import type {
  VideoAdProvider,
  VideoAdRequestOptions,
  VideoAdResult,
  VideoProviderId,
} from "./types";

/** The built-in priority used when `NEXT_PUBLIC_ADS_VIDEO_ORDER` is unset. */
export const VIDEO_PROVIDER_ORDER: readonly VideoProviderId[] = [
  "hilltop",
  "exoclick",
  "adcash",
  "adexchange",
];

export const VIDEO_PROVIDERS: readonly VideoAdProvider[] = [
  hilltopVideoProvider,
  exoclickVideoProvider,
  adcashVideoProvider,
  adexchangeVideoProvider,
];

export function videoProviderById(id: VideoProviderId): VideoAdProvider | null {
  return VIDEO_PROVIDERS.find((provider) => provider.id === id) ?? null;
}

/** Requests one provider by id. An unknown id resolves to "not configured". */
export async function requestVideoAd(
  id: VideoProviderId,
  options: VideoAdRequestOptions = {},
): Promise<VideoAdResult> {
  const provider = videoProviderById(id);
  if (!provider) return { ok: false, provider: id, reason: "not-configured" };
  return provider.request(options);
}
