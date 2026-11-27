// src/lib/vast/providers/exoclick.ts
//
// ExoClick VAST adapter.
//
// No tag URL and no zone id is built in. ExoClick's publisher dashboard issues
// the video zone's VAST tag; it is supplied through
// `NEXT_PUBLIC_EXOCLICK_VAST_TAG`, and the provider stays disabled until an
// operator also switches it on.
//
// The response is read by the SAME strict parser as Hilltop: Inline → Linear →
// progressive video, with Wrapper/VPAID refused. Whether a real ExoClick tag
// answers Inline or Wrapper has to be verified per account (docs/vast-providers.md);
// this adapter does not follow wrappers.

import { normalizeVideoTagUrl, videoAdsGloballyEnabled, videoSwitchOn, videoTimeoutMs } from "./config";
import { requestWithConfig } from "./request";
import type {
  VideoAdProvider,
  VideoAdProviderConfig,
  VideoAdRequestOptions,
  VideoAdResult,
} from "./types";

export function exoclickVideoConfig(): VideoAdProviderConfig {
  const tagUrl = normalizeVideoTagUrl(process.env.NEXT_PUBLIC_EXOCLICK_VAST_TAG);
  return {
    id: "exoclick",
    enabled:
      videoAdsGloballyEnabled() &&
      videoSwitchOn(process.env.NEXT_PUBLIC_EXOCLICK_VAST_ENABLED),
    configured: tagUrl !== null,
    tagUrl,
    timeoutMs: videoTimeoutMs(process.env.NEXT_PUBLIC_EXOCLICK_VAST_TIMEOUT_MS),
    placement: "post-match",
  };
}

export const exoclickVideoProvider: VideoAdProvider = {
  id: "exoclick",
  config: exoclickVideoConfig,
  request: (options?: VideoAdRequestOptions): Promise<VideoAdResult> =>
    requestWithConfig("exoclick", exoclickVideoConfig(), options),
};
