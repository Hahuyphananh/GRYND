// src/lib/vast/providers/adcash.ts
//
// Adcash VAST adapter.
//
// Adcash's video integration supplies a VAST tag URL from the publisher panel
// ("In-stream video VAST tag URL integration"). It is supplied through
// `NEXT_PUBLIC_ADCASH_VAST_TAG`; nothing is invented and the provider stays
// disabled until both the switch and the tag exist.
//
// This is the CONVENTIONAL post-match placement only — never Adcash's floating
// Video Slider. The response is read by the same strict Inline-only parser;
// wrappers and VPAID are refused (docs/vast-providers.md).

import { normalizeVideoTagUrl, videoAdsGloballyEnabled, videoSwitchOn, videoTimeoutMs } from "./config";
import { requestWithConfig } from "./request";
import type {
  VideoAdProvider,
  VideoAdProviderConfig,
  VideoAdRequestOptions,
  VideoAdResult,
} from "./types";

export function adcashVideoConfig(): VideoAdProviderConfig {
  const tagUrl = normalizeVideoTagUrl(process.env.NEXT_PUBLIC_ADCASH_VAST_TAG);
  return {
    id: "adcash",
    enabled:
      videoAdsGloballyEnabled() &&
      videoSwitchOn(process.env.NEXT_PUBLIC_ADCASH_VAST_ENABLED),
    configured: tagUrl !== null,
    tagUrl,
    timeoutMs: videoTimeoutMs(process.env.NEXT_PUBLIC_ADCASH_VAST_TIMEOUT_MS),
    placement: "post-match",
  };
}

export const adcashVideoProvider: VideoAdProvider = {
  id: "adcash",
  config: adcashVideoConfig,
  request: (options?: VideoAdRequestOptions): Promise<VideoAdResult> =>
    requestWithConfig("adcash", adcashVideoConfig(), options),
};
